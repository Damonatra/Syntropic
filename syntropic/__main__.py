from syntropic.core.engine import build_syntropic_engine


def main() -> None:
    app = build_syntropic_engine()
    initial_state = {
        "raw_input": "PN: VALVE-1/2-SS\nQty: 500",
        "extracted_data": {},
        "confidence_score": 0.0,
        "validation_errors": [],
        "retry_count": 0,
        "execution_log": [],
    }

    result = app.invoke(initial_state)
    print("\n--- FINAL EXECUTION LOG ---")
    for log in result.get("execution_log", []):
        print(f"• {log}")
    print("\n--- MATCHED CATALOG ITEM ---")
    print(result.get("matched_catalog_item"))


if __name__ == "__main__":
    main()
