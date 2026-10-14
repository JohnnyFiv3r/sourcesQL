"""Headless developer entry point; fixture mode by default."""

import argparse
import os
from pathlib import Path
import sys
from open_webql.contracts import WebQLError, canonical
from open_webql.engine import Engine, strict_json


def main():
    parser = argparse.ArgumentParser(prog="webql")
    parser.add_argument("--store", default=os.environ.get("WEBQL_DATA_DIR", "local/engine"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("capabilities").add_argument("--json", action="store_true")
    for command in ["query", "explain"]:
        p = commands.add_parser(command)
        p.add_argument("--file", type=Path)
        p.add_argument("--sql")
        p.add_argument("--request", type=Path)
        p.add_argument("--profile", default="fixture")
        p.add_argument("--json", action="store_true")
    p = commands.add_parser("read")
    p.add_argument("result_id")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--limit", type=int, default=100)
    p = commands.add_parser("export")
    p.add_argument("--result", required=True)
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("import")
    p.add_argument("file", type=Path)
    p.add_argument("--no-network", action="store_true")
    p = commands.add_parser("demo")
    p.add_argument("--profile", choices=["fixture"], default="fixture")
    p.add_argument("--output", type=Path, default=Path("artifacts/demo"))
    args = parser.parse_args()
    try:
        profile_path = os.environ.get("WEBQL_PROFILES_FILE")
        engine = Engine(
            args.store,
            profiles=strict_json(Path(profile_path).read_bytes()) if profile_path else None,
        )
        if args.command == "capabilities":
            result = engine.capabilities()
        elif args.command in ["query", "explain"]:
            request = (
                strict_json(args.request.read_bytes())
                if args.request
                else {
                    "query": args.file.read_text() if args.file else args.sql,
                    "profile": args.profile,
                }
            )
            result = getattr(engine, args.command)(**request)
        elif args.command == "read":
            result = engine.read_result(args.result_id, args.offset, args.limit)
        elif args.command == "export":
            result = engine.export(args.result)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical(result))
        elif args.command == "import":
            result = engine.import_bundle(strict_json(args.file.read_bytes()))
        else:
            result = engine.query(
                query="SELECT url, SEM_EXTRACT(content, 'project name explicitly stated') AS project, SEM_EXTRACT(content, 'planned capacity in MW, number only') AS planned_mw FROM WEB_SEARCH('fictional Aurora Birch campuses') WHERE SEM_MATCH(content, 'describes a specific data-center campus')",
                profile="fixture",
            )
            args.output.mkdir(parents=True, exist_ok=True)
            (args.output / "result.json").write_bytes(canonical(result))
            (args.output / "bundle.json").write_bytes(canonical(engine.export(result["result_id"])))
        print(canonical(result).decode())
    except WebQLError as error:
        print(
            canonical(
                {"error": {"code": error.code, "message": error.safe_message, "stage": error.stage}}
            ).decode(),
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
