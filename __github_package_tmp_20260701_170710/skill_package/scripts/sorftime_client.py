#!/usr/bin/env python3
"""Small Sorftime CLI wrapper with audit logging and safe secret handling."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = Path(os.getenv(
    "AMAZON_MONITOR_DATA_DIR",
    "D:/amazon-competitor-monitor-web-data" if os.name == "nt" else str(PACKAGE_ROOT),
))
WORK_ROOT = Path(os.getenv(
    "AMAZON_MONITOR_SKILL_WORK_ROOT",
    str(DEFAULT_DATA_ROOT / "skill_package") if DEFAULT_DATA_ROOT != PACKAGE_ROOT else str(PACKAGE_ROOT),
))
ROOT = PACKAGE_ROOT
CACHE_RAW = WORK_ROOT / "cache" / "raw"
AUDIT_PATH = WORK_ROOT / "outputs" / "request_audit.jsonl"


def rel_path(path: Path) -> str:
    for base in (WORK_ROOT, PACKAGE_ROOT):
        try:
            return str(path.relative_to(base))
        except ValueError:
            continue
    return str(path)


def load_dotenv(path: Path = PACKAGE_ROOT / ".env") -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


@dataclass
class AuditRecord:
    timestamp: str
    interface: str
    params: Dict[str, Any]
    domain: int
    command_preview: str
    exit_code: Optional[int]
    raw_response_file: str
    stderr_file: str
    cache_hit: bool
    duration_ms: int
    error: Optional[str] = None


class SorftimeClient:
    def __init__(self, domain: int = 1, sorftime_bin: Optional[str] = None, dry_run: bool = False):
        load_dotenv()
        self.domain = int(domain or os.getenv("SORFTIME_DOMAIN", "1"))
        self.bin = sorftime_bin or os.getenv("SORFTIME_BIN") or shutil.which("sorftime") or shutil.which("sorftime.cmd") or "sorftime"
        self.dry_run = dry_run
        CACHE_RAW.mkdir(parents=True, exist_ok=True)
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)

    def _cache_key(self, interface: str, params: Dict[str, Any]) -> str:
        payload = json.dumps({"interface": interface, "params": params, "domain": self.domain}, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def call(self, interface: str, params: Dict[str, Any], use_cache: bool = True) -> Dict[str, Any]:
        cache_key = self._cache_key(interface, params)
        raw_file = CACHE_RAW / f"{datetime.now().strftime('%Y%m%d')}_{interface}_{cache_key}.json"
        stderr_file = CACHE_RAW / f"{datetime.now().strftime('%Y%m%d')}_{interface}_{cache_key}.stderr.txt"

        if use_cache and raw_file.exists():
            self._write_audit(AuditRecord(
                timestamp=datetime.now().isoformat(timespec="seconds"),
                interface=interface,
                params=params,
                domain=self.domain,
                command_preview=self._preview_command(interface, params),
                exit_code=0,
                raw_response_file=rel_path(raw_file),
                stderr_file=rel_path(stderr_file),
                cache_hit=True,
                duration_ms=0,
            ))
            return json.loads(raw_file.read_text(encoding="utf-8"))

        if self.dry_run:
            record = AuditRecord(
                timestamp=datetime.now().isoformat(timespec="seconds"),
                interface=interface,
                params=params,
                domain=self.domain,
                command_preview=self._preview_command(interface, params),
                exit_code=None,
                raw_response_file=rel_path(raw_file),
                stderr_file=rel_path(stderr_file),
                cache_hit=False,
                duration_ms=0,
                error="dry-run only; CLI not executed",
            )
            self._write_audit(record)
            return {"dry_run": True, "interface": interface, "params": params}

        command = [self.bin, "api", interface, json.dumps(params, ensure_ascii=False), "--domain", str(self.domain)]

        env = os.environ.copy()
        token = env.get("SORFTIME_CLI_TOKEN")
        if token:
            # 兼容不同 CLI 版本：优先通过环境变量传递，不把密钥写入命令和审计。
            env.setdefault("SORFTIME_TOKEN", token)
            env.setdefault("SORFTIME_API_KEY", token)

        start = time.time()
        proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, shell=False)
        duration_ms = int((time.time() - start) * 1000)
        stderr_file.write_text(proc.stderr or "", encoding="utf-8")

        error = None
        data: Dict[str, Any]
        if proc.returncode != 0:
            error = f"Sorftime CLI exited with code {proc.returncode}"
            data = {"error": error, "stdout": proc.stdout, "stderr_file": rel_path(stderr_file)}
        else:
            try:
                data = json.loads(proc.stdout)
            except json.JSONDecodeError:
                data = {"raw_text": proc.stdout}

        raw_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._write_audit(AuditRecord(
            timestamp=datetime.now().isoformat(timespec="seconds"),
            interface=interface,
            params=params,
            domain=self.domain,
            command_preview=self._preview_command(interface, params),
            exit_code=proc.returncode,
            raw_response_file=rel_path(raw_file),
            stderr_file=rel_path(stderr_file),
            cache_hit=False,
            duration_ms=duration_ms,
            error=error,
        ))
        if error:
            raise RuntimeError(f"{error}. See {stderr_file}")
        return data

    def _preview_command(self, interface: str, params: Dict[str, Any]) -> str:
        return f"{Path(self.bin).name} api {interface} '<json params>' --domain {self.domain}"

    def _write_audit(self, record: AuditRecord) -> None:
        with AUDIT_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")
