from __future__ import annotations

from hashlib import sha256
import json
import logging
import os
from pathlib import Path
from threading import Lock

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import RemoteEntryNotFoundError

logger = logging.getLogger(__name__)


class RouteStore:
    """Store saved navigation routes in a private Hugging Face dataset."""

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

    def _path(self, user_id: str) -> str:
        return "saved-routes/" + sha256(user_id.encode()).hexdigest() + ".json"

    def _read(self, user_id: str) -> list[dict]:
        try:
            path = hf_hub_download(self.repo, self._path(user_id), repo_type="dataset", token=self.token)
        except RemoteEntryNotFoundError:
            return []
        file_size = Path(path).stat().st_size
        if file_size > 2_000_000:
            logger.warning("Saved routes file exceeds 2MB limit for user %s", user_id)
            return []
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("version") != 1 or not isinstance(data.get("routes"), list):
            return []
        return data["routes"][:20]

    def _write(self, user_id: str, routes: list[dict]) -> None:
        payload = json.dumps({"version": 1, "routes": routes}, ensure_ascii=False).encode()
        if len(payload) > 2_000_000:
            raise ValueError("Routes data exceeds 2MB limit")
        api = self._client()
        api.upload_file(
            path_or_fileobj=payload,
            path_in_repo=self._path(user_id),
            repo_id=self.repo,
            repo_type="dataset",
            commit_message=f"Update saved routes for {user_id[:8]}...",
        )

    def get_routes(self, user_id: str) -> list[dict]:
        with self.lock:
            if not self.configured:
                return []
            try:
                return self._read(user_id)
            except Exception as exc:
                logger.warning("Failed to load routes from HF: %s", exc)
                return []

    def save_route(self, user_id: str, route_data: dict) -> dict | None:
        with self.lock:
            if not self.configured:
                return None
            try:
                routes = self._read(user_id)
                routes.insert(0, route_data)
                routes = routes[:20]
                self._write(user_id, routes)
                return route_data
            except Exception as exc:
                logger.warning("Failed to save route to HF: %s", exc)
                return None

    def delete_route(self, user_id: str, route_id: str) -> bool:
        with self.lock:
            if not self.configured:
                return False
            try:
                routes = self._read(user_id)
                original_len = len(routes)
                routes = [r for r in routes if r.get("id") != route_id]
                if len(routes) == original_len:
                    return False
                self._write(user_id, routes)
                return True
            except Exception as exc:
                logger.warning("Failed to delete route from HF: %s", exc)
                return False


store = RouteStore()
