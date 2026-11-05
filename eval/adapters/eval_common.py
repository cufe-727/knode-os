"""Shared plumbing for the eval suite's external-system adapters (docs/design/23 §3).

An adapter is a long-lived process speaking JSON lines on stdin/stdout:
    → {"id": 1, "op": "build", ...}      ← {"id": 1, "ok": true, "result": {...}}
Log lines go out as {"log": "..."}; anything else a library prints to stdout is
ignored by the runner unless it starts with "{", so libraries are pointed at
stderr where possible. Model calls reach the run's shim (OPENAI_BASE_URL) with the
meter tag as the API key — set per request, so a task's calls are its own.
"""
import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

BASE_URL = os.environ.get("OPENAI_BASE_URL", "")
CHAT_MODEL = "gpt-4o-mini"  # a name tiktoken and the libraries know; the shim answers every name with Codex
EMBED_MODEL = "text-embedding-3-small"
_key = {"value": os.environ.get("OPENAI_API_KEY", "sys=external;stage=build")}

_stdout = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol


def emit(obj) -> None:
    _stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    _stdout.flush()


def log(msg: str) -> None:
    emit({"log": msg})


def set_key(key: str | None) -> None:
    if key:
        _key["value"] = key
        os.environ["OPENAI_API_KEY"] = key
        os.environ["GRAPHRAG_API_KEY"] = key


def key() -> str:
    return _key["value"]


def read_corpus(corpus_dir: str) -> list[tuple[str, str]]:
    root = Path(corpus_dir)
    out = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and not p.name.startswith(".") and p.suffix in (".md", ".txt", ".markdown"):
            out.append((p.relative_to(root).as_posix(), p.read_text(encoding="utf-8", errors="replace")))
    return out


def chat_messages(prompt: str, system_prompt: str | None = None, history=None) -> list[dict]:
    msgs = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    for h in history or []:
        msgs.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    msgs.append({"role": "user", "content": prompt})
    return msgs


async def achat(messages: list[dict], json_mode: bool = False) -> str:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(base_url=BASE_URL, api_key=key(), timeout=1800, max_retries=1)
    kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
    r = await client.chat.completions.create(model=CHAT_MODEL, messages=messages, **kwargs)
    if not getattr(r, "choices", None):
        raise RuntimeError(f"model call failed: {getattr(r, 'error', None) or r}")
    return r.choices[0].message.content or ""


async def aembed(texts: list[str]):
    import numpy as np
    from openai import AsyncOpenAI

    client = AsyncOpenAI(base_url=BASE_URL, api_key=key(), timeout=1800, max_retries=1)
    r = await client.embeddings.create(model=EMBED_MODEL, input=texts)
    return np.array([d.embedding for d in r.data], dtype="float32")


def serve(handlers: dict) -> None:
    loop = asyncio.new_event_loop()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            set_key(req.get("api_key"))
            fn = handlers[req["op"]]
            result = fn(req)
            if asyncio.iscoroutine(result):
                result = loop.run_until_complete(result)
            emit({"id": rid, "ok": True, "result": result})
        except Exception as e:  # noqa: BLE001 — every failure goes back to the runner
            emit({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-3000:]})
