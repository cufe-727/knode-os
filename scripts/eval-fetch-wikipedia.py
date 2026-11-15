"""Fetch the Wikipedia revisions FanOutQA and FRAMES questions draw on.

Run with `python3 -I scripts/eval-fetch-wikipedia.py <out-dir> <frames test.tsv> <fanoutqa dev.json>`.

- FanOutQA (dev) names each evidence page with the revision it was written
  against: that revision is fetched.
- FRAMES lists article URLs only: each is resolved (redirects followed) to the
  last revision before FRAMES_EPOCH, the month the dataset was published, so
  the text is what its annotators read and the gold still holds.

Revisions are fetched as wikitext, 50 to a request, and kept gzipped at
`<out>/pages/<revid>.json.gz`; `<out>/index.jsonl` maps every requested
title or URL to its revision. A rerun skips what is already fetched.

Wikimedia rate-limits unauthenticated clients (2026): requests go one at a
time, at least PACE seconds apart, and a 429 waits out its Retry-After. The
client sends a generic user agent and nothing else.
"""

import csv
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://en.wikipedia.org/w/api.php"
UA = "dataset-fetch/0.1"
FRAMES_EPOCH = "2024-09-30T23:59:59Z"
# FanOutQA's epoch, for its few evidence pages whose revision is a placeholder
FANOUT_EPOCH = "2023-11-20T23:59:59Z"
PACE = 2.0
_last = [0.0]


def get(params, tries=8):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for k in range(tries):
        wait = PACE - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if k == tries - 1:
                raise
            retry = e.headers.get("Retry-After") if e.headers else None
            pause = (int(retry) + 5) if retry and retry.isdigit() else 30 * (k + 1)
            print(f"HTTP {e.code}: waiting {pause}s", flush=True)
            time.sleep(pause)
        except Exception as e:  # noqa: BLE001 - retried, then raised
            if k == tries - 1:
                raise
            print(f"{type(e).__name__}: retrying", flush=True)
            time.sleep(10 * (k + 1))


def title_of(url):
    path = urllib.parse.urlparse(url).path
    name = path.split("/wiki/", 1)[-1]
    return urllib.parse.unquote(name).replace("_", " ").split("#")[0].strip()


def resolve(title, epoch=FRAMES_EPOCH):
    """The last revision of a title (after redirects) before an epoch."""
    q = get({"action": "query", "prop": "revisions", "titles": title, "redirects": 1, "rvlimit": 1, "rvdir": "older",
             "rvstart": epoch, "rvprop": "ids|timestamp"})
    pages = q.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing") or not pages[0].get("revisions"):
        return None
    p = pages[0]
    return {"pageid": p["pageid"], "title": p["title"], "revid": p["revisions"][0]["revid"], "timestamp": p["revisions"][0]["timestamp"]}


def fetch_batch(out, revids):
    """Wikitext of up to 50 revisions; what the API leaves for a continuation is asked for again."""
    todo = list(revids)
    while todo:
        r = get({"action": "query", "prop": "revisions", "revids": "|".join(map(str, todo)), "rvprop": "ids|timestamp|content", "rvslots": "main"})
        got = set()
        for p in r.get("query", {}).get("pages", []):
            for rev in p.get("revisions", []):
                text = rev.get("slots", {}).get("main", {}).get("content")
                if text is None:
                    continue
                rec = {"title": p["title"], "pageid": p["pageid"], "revid": rev["revid"], "timestamp": rev.get("timestamp"), "wikitext": text}
                file = os.path.join(out, "pages", f"{rev['revid']}.json.gz")
                with gzip.open(file + ".part", "wt", encoding="utf-8") as f:
                    json.dump(rec, f, ensure_ascii=False)
                os.replace(file + ".part", file)
                got.add(rev["revid"])
        bad = [int(x) for x in r.get("query", {}).get("badrevids", {}) or []]
        for b in bad:
            print(f"revision {b}: bad revid", flush=True)
        rest = [x for x in todo if x not in got and x not in bad]
        if len(rest) == len(todo):
            print(f"no progress on {rest[:3]}…: left out", flush=True)
            return
        todo = rest


def main():
    out, frames_tsv, fanout_json = sys.argv[1:4]
    os.makedirs(os.path.join(out, "pages"), exist_ok=True)
    index_file = os.path.join(out, "index.jsonl")
    index = {}
    if os.path.exists(index_file):
        for line in open(index_file, encoding="utf-8"):
            rec = json.loads(line)
            index[rec["key"]] = rec
    idx = open(index_file, "a", encoding="utf-8")

    def note(rec):
        index[rec["key"]] = rec
        idx.write(json.dumps(rec, ensure_ascii=False) + "\n")
        idx.flush()

    # FanOutQA: revisions are given
    def walk(n, acc):
        if n.get("evidence"):
            acc.append(n["evidence"])
        for c in n.get("decomposition") or []:
            walk(c, acc)
    for q in json.load(open(fanout_json, encoding="utf-8")):
        acc = []
        walk(q, acc)
        for e in acc:
            key = f"fanoutqa:{e['pageid']}:{e['revid']}"
            if key in index:
                continue
            if str(e["revid"]).isdigit():
                note({"key": key, "dataset": "fanoutqa", "title": e["title"], "pageid": e["pageid"], "revid": int(e["revid"]), "url": e.get("url")})
            else:
                r = resolve(e["title"], FANOUT_EPOCH)
                note({"key": key, "dataset": "fanoutqa", "url": e.get("url"), "givenRevid": str(e["revid"]), **(r or {"title": e["title"], "missing": True})})

    # what is known already (FanOutQA's revisions) first: it needs no resolving
    fetch_known(out, index)

    # FRAMES: resolve URLs to revisions as of the epoch, one request each
    links = []
    for row in csv.DictReader(open(frames_tsv, encoding="utf-8"), delimiter="\t"):
        for k, v in row.items():
            if k and k.startswith("wikipedia_link") and v and v.strip():
                links.append(v.strip())
    todo = sorted({u for u in links if f"frames:{u}" not in index})
    print(f"FRAMES: {len(set(links))} links, {len(todo)} to resolve", flush=True)
    for i, u in enumerate(todo):
        r = resolve(title_of(u))
        note({"key": f"frames:{u}", "dataset": "frames", "url": u, **(r or {"missing": True})})
        if (i + 1) % 100 == 0:
            print(f"resolved {i + 1}/{len(todo)}", flush=True)

    fetch_known(out, index)
    print("done", flush=True)


def fetch_known(out, index):
    have = {int(f.split(".")[0]) for f in os.listdir(os.path.join(out, "pages")) if f.endswith(".json.gz")}
    revids = sorted({int(r["revid"]) for r in index.values() if str(r.get("revid", "")).isdigit()} - have)
    print(f"{len(revids)} revisions to fetch", flush=True)
    for i in range(0, len(revids), 50):
        fetch_batch(out, revids[i:i + 50])
        print(f"fetched {min(i + 50, len(revids))}/{len(revids)}", flush=True)


if __name__ == "__main__":
    main()
