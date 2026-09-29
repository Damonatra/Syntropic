# Syntropic
An open-source, event-driven agentic framework designed to orchestrate self-optimizing, adaptive AI workflows. Engineered for modularity, low-latency state synchronization, and scalable multi-agent execution in production environments.

## Local development

Use Python 3.12 from the project root.

```bat
set "PYTHON312=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
set "SYNTROPIC_VENV=%LOCALAPPDATA%\venvs\Syntropic312"
%PYTHON312% -m venv "%SYNTROPIC_VENV%"
"%SYNTROPIC_VENV%\Scripts\python.exe" -m pip install -r requirements-dev.txt
"%SYNTROPIC_VENV%\Scripts\python.exe" -m syntropic
```

This runs the packaged workflow demo and prints the final execution log plus the matched catalog item.

## Tests

```bat
"%SYNTROPIC_VENV%\Scripts\python.exe" -m pytest -q
```

The review queue is stored in `outputs/review_queue.sqlite3`. The review API has no authentication and the ERP node is a local demo; keep it on loopback and do not expose it to a network.
