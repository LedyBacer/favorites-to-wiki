import cgi
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ru")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
HOST = os.environ.get("SERVICE_HOST", "0.0.0.0")
PORT = int(os.environ.get("SERVICE_PORT", "8000"))
API_KEY = os.environ.get("ASR_SERVICE_API_KEY")

_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _model


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json({"ok": True, "model": MODEL, "device": DEVICE, "language": LANGUAGE})
            return
        self.send_error(404)

    def do_POST(self):
        if self.path != "/transcribe":
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

        suffix = os.path.splitext(getattr(file_item, "filename", "") or "input.ogg")[1] or ".ogg"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(file_item.file.read())
            tmp_path = tmp.name
        try:
            segments, info = get_model().transcribe(
                tmp_path,
                beam_size=BEAM_SIZE,
                language=LANGUAGE or None,
                vad_filter=True,
            )
            segment_rows = [
                {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                for segment in segments
            ]
            self.send_json(
                {
                    "text": " ".join(segment["text"] for segment in segment_rows).strip(),
                    "language": info.language,
                    "languageProbability": info.language_probability,
                    "durationSeconds": info.duration,
                    "model": MODEL,
                    "segments": segment_rows,
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
    print(f"Starting ASR service on {HOST}:{PORT} with {MODEL} ({DEVICE}/{COMPUTE_TYPE})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
