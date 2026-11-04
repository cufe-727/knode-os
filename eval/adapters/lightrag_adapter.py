"""LightRAG (HKU) behind the eval suite's JSON-lines protocol (docs/design/23 §3).

Build inserts every corpus document (id and file path = its corpus path), with
gleaning off and the summary language set to the corpus's. Answers use LightRAG's
own query ("mix" for questions, "global" for corpus-wide ones); retrieval and
answer contexts come from `aquery_data`'s chunks and their file paths. Export
reads the entity–relation graph LightRAG keeps in `graph_chunk_entity_relation.graphml`.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from eval_common import achat, aembed, chat_messages, log, read_corpus, serve  # noqa: E402

_rags: dict[str, object] = {}


async def _make(work_dir: str, language: str, dim: int):
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc

    if work_dir in _rags:
        return _rags[work_dir]

    async def llm(prompt, system_prompt=None, history_messages=None, keyword_extraction=False, **kwargs):
        return await achat(chat_messages(prompt, system_prompt, history_messages), json_mode=bool(keyword_extraction))

    rag = LightRAG(
        working_dir=work_dir,
        llm_model_func=llm,
        embedding_func=EmbeddingFunc(embedding_dim=dim, max_token_size=8192, func=aembed),
        entity_extract_max_gleaning=0,
        llm_model_max_async=4,
        addon_params={"language": language},
    )
    await rag.initialize_storages()
    try:
        from lightrag.kg.shared_storage import initialize_pipeline_status

        await initialize_pipeline_status()
    except Exception:  # noqa: BLE001 — older and newer releases differ here
        pass
    _rags[work_dir] = rag
    return rag


def _graph_counts(work_dir: str) -> dict:
    f = Path(work_dir) / "graph_chunk_entity_relation.graphml"
    if not f.exists():
        return {}
    import networkx as nx

    g = nx.read_graphml(f)
    return {"entities": g.number_of_nodes(), "relations": g.number_of_edges()}


async def build(req):
    rag = await _make(req["work_dir"], req.get("language", "English"), int(req.get("embedding_dim", 1024)))
    docs = read_corpus(req["corpus_dir"])
    log(f"inserting {len(docs)} documents")
    await rag.ainsert([t for _, t in docs], ids=[p for p, _ in docs], file_paths=[p for p, _ in docs])
    return {"documents": len(docs), **_graph_counts(req["work_dir"])}


async def update(req):
    rag = await _make(req["work_dir"], req.get("language", "English"), int(req.get("embedding_dim", 1024)))
    files = [p for p in req.get("files", []) if os.path.exists(os.path.join(req["corpus_dir"], p))]
    texts = [open(os.path.join(req["corpus_dir"], p), encoding="utf-8").read() for p in files]
    if texts:
        await rag.ainsert(texts, ids=files, file_paths=files)
    return {"updated": len(files), **_graph_counts(req["work_dir"])}


async def open_(req):
    await _make(req["work_dir"], req.get("language", "English"), int(req.get("embedding_dim", 1024)))
    return {"ok": True}


def _docs_of(data) -> list[str]:
    chunks = (data or {}).get("data", {}).get("chunks", []) or []
    out = []
    for c in chunks:
        fp = c.get("file_path") or ""
        for p in fp.split("<SEP>"):
            p = p.strip()
            if p and p not in out:
                out.append(p)
    return out


async def answer(req):
    from lightrag import QueryParam

    rag = _rags[req["work_dir"]]
    mode = "global" if req.get("mode") == "global" else "mix"
    text = await rag.aquery(req["question"], param=QueryParam(mode=mode))
    data = await rag.aquery_data(req["question"], param=QueryParam(mode=mode))
    return {"text": text if isinstance(text, str) else str(text), "contexts": [{"doc": d} for d in _docs_of(data)]}


async def retrieve(req):
    from lightrag import QueryParam

    rag = _rags[req["work_dir"]]
    data = await rag.aquery_data(req["question"], param=QueryParam(mode="mix"))
    return {"docs": _docs_of(data)[: int(req.get("k", 10))]}


def export(req):
    import networkx as nx

    f = Path(req["work_dir"]) / "graph_chunk_entity_relation.graphml"
    if not f.exists():
        return {"units": []}
    g = nx.read_graphml(f)
    split = lambda s: [x.strip() for x in (s or "").split("<SEP>") if x.strip()]  # noqa: E731
    units = []
    for name, a in g.nodes(data=True):
        units.append({"id": f"entity:{name}", "kind": "entity", "title": name, "text": f"{name} ({a.get('entity_type', '')}): {a.get('description', '')}".strip(), "sources": split(a.get("file_path")), "links": []})
    for s, t, a in g.edges(data=True):
        units.append({"id": f"relation:{s}|{t}", "kind": "relation", "head": s, "tail": t, "relation": a.get("keywords", "related"), "text": f"{s} —{a.get('keywords', 'related')}→ {t}: {a.get('description', '')}", "sources": split(a.get("file_path")), "links": [f"entity:{s}", f"entity:{t}"]})
    return {"units": units}


if __name__ == "__main__":
    serve({"build": build, "update": update, "open": open_, "answer": answer, "retrieve": retrieve, "export": export})
