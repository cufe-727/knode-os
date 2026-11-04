"""Microsoft GraphRAG behind the eval suite's JSON-lines protocol (docs/design/23 §3).

Build runs GraphRAG's own CLI on a project it initialises in the work directory:
models pointed at the run's shim (api_base, the meter tag as GRAPHRAG_API_KEY),
gleaning off (its yes/no check relies on logit_bias, which a CLI model ignores),
every corpus document copied into input/ as text (`a/b.md` → `a__b.md.txt`, so a
document title maps back to its corpus path). Local search answers questions,
global search answers corpus-wide ones. Export reads the parquet tables.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from eval_common import BASE_URL, CHAT_MODEL, EMBED_MODEL, key, log, read_corpus, serve  # noqa: E402

BIN = Path(sys.executable).parent / "graphrag"


def _env():
    return {**os.environ, "GRAPHRAG_API_KEY": key()}


def _point_at_shim(root: Path) -> None:
    """Each run's shim listens on a new port: rewrite the models' api_base before using a built index."""
    import yaml

    f = root / "settings.yaml"
    s = yaml.safe_load(f.read_text())
    changed = False
    for group in ("completion_models", "embedding_models"):
        for m in s.get(group, {}).values():
            if m.get("api_base") != BASE_URL:
                m["api_base"] = BASE_URL
                changed = True
    if changed:
        f.write_text(yaml.safe_dump(s, allow_unicode=True, sort_keys=False))


def _flat(path: str) -> str:
    return path.replace("/", "__") + ".txt"


def _unflat(title: str) -> str:
    t = title[:-4] if title.endswith(".txt") else title
    return t.replace("__", "/")


def build(req):
    import yaml

    root = Path(req["work_dir"])
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    subprocess.run([str(BIN), "init", "--root", str(root)], input=f"{CHAT_MODEL}\n{EMBED_MODEL}\n", text=True, check=True, capture_output=True, env=_env())
    settings_file = root / "settings.yaml"
    s = yaml.safe_load(settings_file.read_text())
    for group in ("completion_models", "embedding_models"):
        for m in s.get(group, {}).values():
            m["api_base"] = BASE_URL
            m["api_key"] = "${GRAPHRAG_API_KEY}"
    for section in ("extract_graph", "extract_claims"):
        if section in s:
            s[section]["max_gleanings"] = 0
    s["input"] = {**s.get("input", {}), "type": "text", "file_pattern": ".*\\.txt$$"}  # "$$": GraphRAG expands $ in settings
    settings_file.write_text(yaml.safe_dump(s, allow_unicode=True, sort_keys=False))
    inp = root / "input"
    inp.mkdir(exist_ok=True)
    docs = read_corpus(req["corpus_dir"])
    for p, text in docs:
        (inp / _flat(p)).write_text(text, encoding="utf-8")
    log(f"indexing {len(docs)} documents")
    r = subprocess.run([str(BIN), "index", "--root", str(root)], text=True, capture_output=True, env=_env())
    if r.returncode != 0:
        raise RuntimeError(f"graphrag index failed ({r.returncode}): {(r.stderr or r.stdout)[-1500:]}")
    return {"documents": len(docs), **_counts(root)}


def _counts(root: Path) -> dict:
    import pandas as pd

    out = {}
    for name in ("entities", "relationships", "communities", "community_reports", "text_units"):
        f = root / "output" / f"{name}.parquet"
        if f.exists():
            out[name] = len(pd.read_parquet(f))
    return out


def update(req):
    root = Path(req["work_dir"])
    _point_at_shim(root)
    for p in req.get("files", []):
        src = Path(req["corpus_dir"]) / p
        if src.exists():
            (root / "input" / _flat(p)).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    r = subprocess.run([str(BIN), "update", "--root", str(root)], text=True, capture_output=True, env=_env())
    if r.returncode != 0:
        raise RuntimeError(f"graphrag update failed ({r.returncode}): {(r.stderr or r.stdout)[-1500:]}")
    return {"updated": len(req.get("files", [])), **_counts(root)}


def open_(req):
    if not (Path(req["work_dir"]) / "output").exists():
        raise RuntimeError("no GraphRAG index in the work directory")
    _point_at_shim(Path(req["work_dir"]))
    return {"ok": True}


def answer(req):
    _point_at_shim(Path(req["work_dir"]))
    method = "global" if req.get("mode") == "global" else "local"
    r = subprocess.run([str(BIN), "query", "--root", req["work_dir"], "--method", method, req["question"]], text=True, capture_output=True, env=_env())
    if r.returncode != 0:
        raise RuntimeError(f"graphrag query failed ({r.returncode}): {(r.stderr or r.stdout)[-1200:]}")
    return {"text": r.stdout.strip(), "contexts": []}


def export(req):
    import pandas as pd

    out = Path(req["work_dir"]) / "output"
    read = lambda n: pd.read_parquet(out / f"{n}.parquet") if (out / f"{n}.parquet").exists() else None  # noqa: E731
    docs, units_tbl, ents, rels, reports = read("documents"), read("text_units"), read("entities"), read("relationships"), read("community_reports")
    doc_title = {} if docs is None else {r["id"]: _unflat(str(r["title"])) for _, r in docs.iterrows()}
    unit_docs = {}
    if units_tbl is not None:
        for _, r in units_tbl.iterrows():
            ids = r.get("document_ids") if "document_ids" in r else [r.get("document_id")]
            unit_docs[r["id"]] = [doc_title.get(d) for d in (list(ids) if ids is not None else []) if doc_title.get(d)]
    srcs = lambda ids: sorted({d for u in (list(ids) if ids is not None else []) for d in unit_docs.get(u, [])})  # noqa: E731
    result = []
    if ents is not None:
        for _, r in ents.iterrows():
            result.append({"id": f"entity:{r['title']}", "kind": "entity", "title": str(r["title"]), "text": f"{r['title']} ({r.get('type', '')}): {r.get('description', '')}", "sources": srcs(r.get("text_unit_ids")), "links": []})
    if rels is not None:
        for _, r in rels.iterrows():
            result.append({"id": f"relation:{r['source']}|{r['target']}", "kind": "relation", "head": str(r["source"]), "tail": str(r["target"]), "relation": "related", "text": f"{r['source']} —related→ {r['target']}: {r.get('description', '')}", "sources": srcs(r.get("text_unit_ids")), "links": [f"entity:{r['source']}", f"entity:{r['target']}"]})
    if reports is not None:
        for _, r in reports.iterrows():
            result.append({"id": f"community:{r.get('community', r.get('id'))}", "kind": "community", "title": str(r.get("title", "")), "text": str(r.get("full_content") or r.get("summary") or ""), "sources": [], "links": []})
    return {"units": result}


if __name__ == "__main__":
    serve({"build": build, "update": update, "open": open_, "answer": answer, "export": export})
