import cgi
import gc
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("PADDLEOCR_RECOGNITION_MODEL", "eslav_PP-OCRv5_mobile_rec")
DETECTION_MODEL = os.environ.get("PADDLEOCR_DETECTION_MODEL", "PP-OCRv5_mobile_det")
DEVICE = os.environ.get("PADDLEOCR_DEVICE", "cpu")
HOST = os.environ.get("SERVICE_HOST", "0.0.0.0")
PORT = int(os.environ.get("SERVICE_PORT", "8000"))
API_KEY = os.environ.get("OCR_SERVICE_API_KEY")
IDLE_UNLOAD_SECONDS = int(os.environ.get("MODEL_IDLE_UNLOAD_SECONDS", "60"))

_ocr = None
_last_used_at = 0.0
_model_lock = threading.Lock()


def get_ocr():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR

        _ocr = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name=DETECTION_MODEL,
            text_recognition_model_name=MODEL,
            device=DEVICE,
        )
    return _ocr


def predict_ocr(tmp_path):
    global _last_used_at
    with _model_lock:
        results = get_ocr().predict(input=tmp_path)
        _last_used_at = time.monotonic()
        return results


def unload_idle_model_loop():
    global _ocr
    while True:
        time.sleep(min(10, max(1, IDLE_UNLOAD_SECONDS // 2)))
        with _model_lock:
            if _ocr is None or _last_used_at == 0:
                continue
            idle_seconds = time.monotonic() - _last_used_at
            if idle_seconds < IDLE_UNLOAD_SECONDS:
                continue
            print(f"Unloading OCR model after {idle_seconds:.0f}s idle", flush=True)
            _ocr = None
            gc.collect()


def normalize_results(results):
    lines = []
    for page in results if isinstance(results, list) else [results]:
        data = page
        if hasattr(page, "json"):
            data = page.json
        if isinstance(data, dict) and isinstance(data.get("res"), dict):
            data = data["res"]
        if not isinstance(data, dict):
            continue
        texts = data.get("rec_texts") or data.get("texts") or []
        scores = data.get("rec_scores") or []
        boxes = data.get("rec_polys") or data.get("dt_polys") or []
        for index, text in enumerate(texts):
            if not text:
                continue
            lines.append(
                {
                    "text": str(text),
                    "confidence": scores[index] if index < len(scores) else None,
                    "box": boxes[index].tolist() if index < len(boxes) and hasattr(boxes[index], "tolist") else None,
                }
            )
    return lines


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json({"ok": True, "model": MODEL, "device": DEVICE})
            return
        self.send_error(404)

    def do_POST(self):
        if self.path != "/ocr":
            self.send_error(404)
            return
        if API_KEY and self.headers.get("Authorization") != f"Bearer {API_KEY}":
            self.send_error(401)
            return

        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=self.cgi_environ())
        file_item = form["file"] if "file" in form else None
        if file_item is None or not getattr(file_item, "file", None):
            self.send_error(400, "multipart field 'file' is required")
            return

        suffix = os.path.splitext(getattr(file_item, "filename", "") or "input.png")[1] or ".png"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(file_item.file.read())
            tmp_path = tmp.name
        try:
            results = predict_ocr(tmp_path)
            lines = normalize_results(results)
            self.send_json(
                {
                    "text": "\n".join(line["text"] for line in lines),
                    "language": "ru+en",
                    "model": MODEL,
                    "lines": lines,
                }
            )
        except Exception as error:
            self.send_error(500, str(error))
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass

    def cgi_environ(self):
        return {
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": self.headers.get("Content-Type"),
            "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
        }

    def send_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}", flush=True)


if __name__ == "__main__":
    print(f"Starting OCR service on {HOST}:{PORT} with {MODEL} ({DEVICE})", flush=True)
    threading.Thread(target=unload_idle_model_loop, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
