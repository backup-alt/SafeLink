from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import RemoteEntryNotFoundError

logger = logging.getLogger(__name__)

LOCAL_FALLBACK = Path(__file__).resolve().parent.parent / "data" / "emergency-requests.json"


class EmergencyStore:
    """Store emergency assistance requests in a Hugging Face dataset or local fallback."""

    def __init__(self):
        self.repo = os.getenv("HF_CHAT_DATASET_REPO", "").strip()
        self.token = os.getenv("HF_CHAT_TOKEN") or os.getenv("HF_TOKEN")
        self.lock = Lock()

    @property
    def configured(self) -> bool:
        return bool(self.repo and self.token)

    def _client(self) -> HfApi:
        if not self.configured:
            raise ValueError("HF not configured")
        return HfApi(token=self.token)

    def _list_path(self) -> str:
        return "emergency-requests/index.json"

    def _local_read(self) -> list[dict]:
        if not LOCAL_FALLBACK.exists():
            return []
        try:
            data = json.loads(LOCAL_FALLBACK.read_text(encoding="utf-8"))
            if data.get("version") != 1 or not isinstance(data.get("requests"), list):
                return []
            return data["requests"][:100]
        except Exception:
            return []

    def _local_write(self, requests: list[dict]) -> None:
        LOCAL_FALLBACK.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_FALLBACK.write_text(
            json.dumps({"version": 1, "requests": requests}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _read_index(self) -> list[dict]:
        try:
            path = hf_hub_download(self.repo, self._list_path(), repo_type="dataset", token=self.token)
        except RemoteEntryNotFoundError:
            return []
        file_size = Path(path).stat().st_size
        if file_size > 5_000_000:
            logger.warning("Emergency index exceeds 5MB limit")
            return []
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("version") != 1 or not isinstance(data.get("requests"), list):
            return []
        return data["requests"][:100]

    def _write_index(self, requests: list[dict]) -> None:
        payload = json.dumps({"version": 1, "requests": requests}, ensure_ascii=False).encode()
        if len(payload) > 5_000_000:
            raise ValueError("Emergency data exceeds 5MB limit")
        api = self._client()
        api.upload_file(
            path_or_fileobj=payload,
            path_in_repo=self._list_path(),
            repo_id=self.repo,
            repo_type="dataset",
            commit_message="Update emergency requests index",
        )

    def create_request(self, data: dict) -> dict | None:
        with self.lock:
            request_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            record = {
                "id": request_id,
                "created_at": now,
                "status": "created",
                **data,
            }
            if self.configured:
                try:
                    requests = self._read_index()
                    requests.insert(0, record)
                    requests = requests[:100]
                    self._write_index(requests)
                    return record
                except Exception as exc:
                    logger.warning("HF storage failed, falling back to local: %s", exc)
            try:
                requests = self._local_read()
                requests.insert(0, record)
                requests = requests[:100]
                self._local_write(requests)
                return record
            except Exception as exc:
                logger.warning("Local storage failed: %s", exc)
                return None

    def get_request(self, request_id: str) -> dict | None:
        with self.lock:
            if self.configured:
                try:
                    requests = self._read_index()
                    for r in requests:
                        if r.get("id") == request_id:
                            return r
                    return None
                except Exception:
                    pass
            try:
                requests = self._local_read()
                for r in requests:
                    if r.get("id") == request_id:
                        return r
                return None
            except Exception:
                return None


emergency_store = EmergencyStore()
