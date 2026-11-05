"""HippoRAG 2 behind the eval suite's JSON-lines protocol (docs/design/23 §3).

HippoRAG 2.0.0a4 imports vLLM and GritLM for local models; the eval venv has
neither (vLLM needs Linux and CUDA), so they are stubbed — every model call goes
to the run's shim as an OpenAI endpoint instead. Each corpus document is indexed
as one passage whose first line is its corpus path, so retrieved passages map
back to documents. Export reads HippoRAG's OpenIE results: the triples it
extracted per passage.
"""
import glob
import json
import os
import sys
import types

sys.path.insert(0, os.path.dirname(__file__))
from eval_common import BASE_URL, CHAT_MODEL, EMBED_MODEL, key, log, read_corpus, serve  # noqa: E402


class _Unavailable:
    def __init__(self, *a, **k):
        raise RuntimeError("local models are not available in the eval venv")


def _stub(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules.setdefault(name, m)


_stub("gritlm", GritLM=_Unavailable)
_stub("vllm", LLM=_Unavailable, SamplingParams=_Unavailable)
_stub("vllm.lora")
_stub("vllm.lora.request", LoRARequest=_Unavailable)

_instances: dict = {}


def _make(work_dir: str):
    from hipporag import HippoRAG

    if work_dir not in _instances:
        os.environ["OPENAI_API_KEY"] = key()
        _instances[work_dir] = HippoRAG(save_dir=work_dir, llm_model_name=CHAT_MODEL, llm_base_url=BASE_URL, embedding_model_name=EMBED_MODEL, embedding_base_url=BASE_URL)
    hr = _instances[work_dir]
    # the tag of the current request: clients read their key per request
    for owner in (getattr(hr, "llm_model", None), getattr(hr, "embedding_model", None)):
        for attr in ("openai_client", "client"):
            c = getattr(owner, attr, None) if owner is not None else None
            if c is not None and hasattr(c, "api_key"):
                c.api_key = key()
    return hr


def _path_of(passage: str) -> str:
    return passage.split("\n", 1)[0].strip()


def build(req):
    hr = _make(req["work_dir"])
    docs = read_corpus(req["corpus_dir"])
    log(f"indexing {len(docs)} passages")
    hr.index(docs=[f"{p}\n{t}" for p, t in docs])
    return {"documents": len(docs)}


def update(req):
    hr = _make(req["work_dir"])
    files = [p for p in req.get("files", []) if os.path.exists(os.path.join(req["corpus_dir"], p))]
    if files:
        hr.index(docs=[f"{p}\n" + open(os.path.join(req["corpus_dir"], p), encoding="utf-8").read() for p in files])
    return {"updated": len(files)}


def open_(req):
    hr = _make(req["work_dir"])
    if hasattr(hr, "prepare_retrieval_objects"):
        hr.prepare_retrieval_objects()
    return {"ok": True}


def answer(req):
    hr = _make(req["work_dir"])
    out = hr.rag_qa(queries=[req["question"]])
    solutions, responses = out[0], out[1]
    docs = [_path_of(d) for d in (getattr(solutions[0], "docs", None) or [])]
    text = responses[0] if responses else getattr(solutions[0], "answer", "")
    return {"text": str(text), "contexts": [{"doc": d} for d in docs]}


def retrieve(req):
    hr = _make(req["work_dir"])
    sols = hr.retrieve(queries=[req["question"]], num_to_retrieve=int(req.get("k", 10)))
    sols = sols[0] if isinstance(sols, tuple) else sols
    return {"docs": [_path_of(d) for d in (getattr(sols[0], "docs", None) or [])]}


def export(req):
    files = sorted(glob.glob(os.path.join(req["work_dir"], "**", "openie_results*.json"), recursive=True))
    units = []
    for f in files:
        data = json.load(open(f, encoding="utf-8"))
        for d in data.get("docs", []):
            src = _path_of(d.get("passage", ""))
            for e in d.get("extracted_entities", []) or []:
                units.append({"id": f"entity:{e}", "kind": "entity", "title": str(e), "text": str(e), "sources": [src], "links": []})
            for t in d.get("extracted_triples", []) or []:
                if len(t) == 3:
                    h, r, tl = (str(x) for x in t)
                    units.append({"id": f"relation:{h}|{r}|{tl}|{src}", "kind": "relation", "head": h, "tail": tl, "relation": r, "text": f"{h} {r} {tl}", "sources": [src], "links": []})
    # one unit per entity name, its sources merged
    merged, out = {}, []
    for u in units:
        if u["kind"] == "entity":
            m = merged.setdefault(u["id"], {**u, "sources": []})
            m["sources"] = sorted(set(m["sources"]) | set(u["sources"]))
        else:
            out.append(u)
    return {"units": list(merged.values()) + out}


if __name__ == "__main__":
    serve({"build": build, "update": update, "open": open_, "answer": answer, "retrieve": retrieve, "export": export})
