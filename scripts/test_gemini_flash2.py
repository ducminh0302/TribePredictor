#!/usr/bin/env python3
"""Quick Gemini API smoke test for Flash 2.0.

Usage:
  python scripts/test_gemini_flash2.py
  python scripts/test_gemini_flash2.py --message "Hello from local test"
  python scripts/test_gemini_flash2.py --model gemini-2.0-flash

The script will:
1) Load GEMINI_API_KEY from environment or .env.local
2) List available models from Gemini API
3) Pick a Flash 2.0 model that supports generateContent
4) Send one chat message and print the reply
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def load_env_local(start_dir: pathlib.Path) -> None:
    """Load GEMINI_API_KEY from .env.local if not already set."""
    if os.environ.get("GEMINI_API_KEY"):
        return

    candidates = [
        start_dir / ".env.local",
        start_dir.parent / ".env.local",
    ]

    for env_path in candidates:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def http_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        url=url,
        method=method,
        data=data,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error: {exc}") from exc


def list_models(api_key: str) -> list[dict[str, Any]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={urllib.parse.quote(api_key)}"
    data = http_json(url)
    models = data.get("models", [])
    if not isinstance(models, list):
        return []
    return [m for m in models if isinstance(m, dict)]


def supports_generate_content(model: dict[str, Any]) -> bool:
    methods = model.get("supportedGenerationMethods", [])
    if not isinstance(methods, list):
        return False
    return "generateContent" in methods


def normalize_model_name(name: str) -> str:
    # API returns names like "models/gemini-2.0-flash".
    return name.split("/", 1)[1] if name.startswith("models/") else name


def pick_model(models: list[dict[str, Any]], requested: str | None) -> str:
    usable = [m for m in models if supports_generate_content(m)]

    if requested:
        requested_normalized = normalize_model_name(requested.strip())
        for model in usable:
            model_name = normalize_model_name(str(model.get("name", "")))
            if model_name == requested_normalized:
                return model_name

    preferred_order = [
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash-exp",
    ]

    for pref in preferred_order:
        for model in usable:
            model_name = normalize_model_name(str(model.get("name", "")))
            if model_name == pref:
                return model_name

    for model in usable:
        model_name = normalize_model_name(str(model.get("name", "")))
        if "flash" in model_name and "2.0" in model_name:
            return model_name

    for model in usable:
        model_name = normalize_model_name(str(model.get("name", "")))
        if "flash" in model_name:
            return model_name

    if usable:
        return normalize_model_name(str(usable[0].get("name", "")))

    raise RuntimeError("No model supporting generateContent found for this API key/project.")


def generate_content(api_key: str, model: str, message: str) -> str:
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{urllib.parse.quote(model)}:generateContent"
        f"?key={urllib.parse.quote(api_key)}"
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": message}],
            }
        ],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 256,
        },
    }

    data = http_json(endpoint, method="POST", payload=payload)

    candidates = data.get("candidates", [])
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError(f"Empty response payload: {json.dumps(data, ensure_ascii=False)}")

    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content", {}) if isinstance(first, dict) else {}
    parts = content.get("parts", []) if isinstance(content, dict) else []

    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip():
            return part["text"].strip()

    raise RuntimeError(f"No text part in response: {json.dumps(data, ensure_ascii=False)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Gemini Flash 2.0 API smoke test")
    parser.add_argument(
        "--message",
        default="Xin chao Gemini Flash 2.0. Hay tra loi 1 cau ngan bang tieng Viet va xac nhan ban dang hoat dong.",
        help="Message to send",
    )
    parser.add_argument("--model", default=None, help="Exact model name, e.g. gemini-2.0-flash")
    args = parser.parse_args()

    load_env_local(pathlib.Path.cwd())

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("ERROR: GEMINI_API_KEY is missing. Set env var or add it to .env.local.")
        return 1

    print("[1/3] Listing available models...")
    models = list_models(api_key)
    print(f"Found {len(models)} models total.")

    print("[2/3] Selecting model...")
    selected_model = pick_model(models, args.model)
    print(f"Using model: {selected_model}")

    print("[3/3] Sending chat request...")
    reply = generate_content(api_key, selected_model, args.message)

    print("\n=== GEMINI REPLY ===")
    print(reply)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1)
