"""asyncio job scheduler for Vertebra background workers.

Design constraints:
- single event loop, cooperative multitasking — no celery, no redis;
- each :class:`Job` runs on its own interval with jitter to avoid thundering
  herds against Neon and the directories;
- failures are captured per-run with exponential cool-down so one bad source
  never kills the worker process;
- shutdown is graceful: ``stop()`` cancels loops and awaits their drains.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from vertebra.logging_conf import get_logger

log = get_logger("workers.scheduler")


@dataclass(slots=True)
class Job:
    """One scheduled unit of work."""

    name: str
    interval_sec: float
    fn: Callable[[], Awaitable[None]]
    jitter_frac: float = 0.15
    cooldown_on_error_sec: float = 30.0
    run_immediately: bool = False
    _task: asyncio.Task | None = field(default=None, repr=False)
    _stopped: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    async def _loop(self) -> None:
        if not self.run_immediately:
            await self._sleep_interval()
        while not self._stopped.is_set():
            started = time.monotonic()
            try:
                await self.fn()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - job isolation is the point
                log.error("job_failed", job=self.name, error=f"{type(exc).__name__}: {exc}")
                await self._sleep_interval(self.cooldown_on_error_sec)
                continue
            elapsed = time.monotonic() - started
            log.info("job_completed", job=self.name, elapsed_sec=round(elapsed, 2))
            await self._sleep_interval()

    async def _sleep_interval(self, override: float | None = None) -> None:
        interval = override if override is not None else self.interval_sec
        jitter = interval * self.jitter_frac * random.uniform(-1, 1)
        try:
            await asyncio.wait_for(self._stopped.wait(), timeout=max(0.1, interval + jitter))
        except asyncio.TimeoutError:
            pass


class Scheduler:
    """Owns a set of jobs and their asyncio tasks."""

    def __init__(self, jobs: list[Job]) -> None:
        if not jobs:
            raise ValueError("scheduler requires at least one job")
        self._jobs = {job.name: job for job in jobs}

    async def start(self) -> None:
        for job in self._jobs.values():
            job._task = asyncio.create_task(job._loop(), name=f"vertebra-job-{job.name}")
        log.info("scheduler_started", jobs=sorted(self._jobs))

    async def stop(self) -> None:
        for job in self._jobs.values():
            job._stopped.set()
        tasks = [job._task for job in self._jobs.values() if job._task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("scheduler_stopped")

    def status(self) -> dict[str, dict[str, bool | None]]:
        return {
            name: {"running": bool(job._task and not job._task.done())}
            for name, job in self._jobs.items()
        }
