# /// script
# requires-python = ">=3.10"
# dependencies = ["torch>=2.2", "transformers>=4.40", "sentencepiece", "protobuf"]
# ///
"""A local bge-m3 for the benchmark's embeddings (docs/design/23 D18).

An OpenAI-compatible POST /v1/embeddings on 127.0.0.1 only: the CLS token's
hidden state, L2-normalized, 1024 dimensions — the dense vector bge-m3 makes,
the same one the embedding pool serves, so `eval run --embedding-endpoint`
checks it against the vectors a run holds (cosine ≥ 0.999) before using it.

    uv run eval/embed_server.py --port 12020

The first start downloads BAAI/bge-m3 from Hugging Face (about 2.3 GB) into
~/.cache/huggingface and the Python packages into uv's cache. Nothing is sent
anywhere else; it binds loopback and exits when the port is taken.
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "BAAI/bge-m3"
MAX_TOKENS = 8192


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=12020)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    lock = threading.Lock()

    def embed(texts):
        out = []
        for i in range(0, len(texts), args.batch):
            batch = tokenizer(texts[i:i + args.batch], padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt").to(device)
            with lock, torch.no_grad():
                cls = model(**batch).last_hidden_state[:, 0]
                out.extend(torch.nn.functional.normalize(cls.float(), dim=-1).cpu().tolist())
        return out, int(sum(len(ids) for ids in tokenizer(texts)["input_ids"]))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.rstrip("/") in ("/v1/models", "/health"):
                return self.reply(200, {"data": [{"id": "bge-m3", "object": "model"}]})
            self.reply(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/embeddings":
                return self.reply(404, {"error": {"message": "not found"}})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
                texts = body.get("input", [])
                texts = [texts] if isinstance(texts, str) else [str(t) for t in texts]
                vectors, tokens = embed(texts)
                self.reply(200, {"object": "list", "model": "bge-m3", "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
                                 "usage": {"prompt_tokens": tokens, "total_tokens": tokens}})
            except Exception as err:  # noqa: BLE001 — the caller sees the reason
                self.reply(500, {"error": {"message": str(err)}})

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as err:
        sys.exit(f"port {args.port} is taken: {err}")
    print(f"bge-m3 on http://127.0.0.1:{args.port}/v1 ({device})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
