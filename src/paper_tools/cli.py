"""Typer command line interface for web startup and local maintenance."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated

import typer
import uvicorn
from rich.console import Console
from rich.table import Table

from paper_tools import __version__
from paper_tools.config import AppSettings, get_settings, reset_settings_cache
from paper_tools.database import Database
from paper_tools.doctor import doctor_exit_code, run_doctor
from paper_tools.exceptions import PaperToolsError
from paper_tools.launcher import (
    application_url,
    is_paper_tools_ready,
    open_in_default_browser,
    schedule_browser_open,
)
from paper_tools.services.export import ExportService
from paper_tools.services.projects import ProjectService
from paper_tools.services.templates import TemplateService
from paper_tools.services.workflow import PaperWorkflowService

app = typer.Typer(
    name="paper-tools",
    help="Typst論文作成支援Webアプリケーション",
    no_args_is_help=True,
    invoke_without_command=True,
    add_completion=False,
)
console = Console()
error_console = Console(stderr=True)


@app.callback()
def callback(
    version: Annotated[
        bool,
        typer.Option("--version", help="バージョンを表示して終了する", is_eager=True),
    ] = False,
) -> None:
    if version:
        console.print(f"paper-tools {__version__}")
        raise typer.Exit()


@app.command()
def serve(
    host: Annotated[str | None, typer.Option("--host", help="待受けホスト")] = None,
    port: Annotated[int | None, typer.Option("--port", min=1, max=65535)] = None,
    reload: Annotated[bool, typer.Option("--reload", help="開発用の自動再読込")] = False,
) -> None:
    """ローカルWebアプリを起動する．"""

    settings, selected_host, selected_port = _server_settings(host, port)
    _warn_if_remote(selected_host)
    console.print(f"paper_tools: {application_url(selected_host, selected_port)}")
    _run_server(settings, selected_host, selected_port, reload=reload)


@app.command()
def launch(
    host: Annotated[str | None, typer.Option("--host", help="待受けホスト")] = None,
    port: Annotated[int | None, typer.Option("--port", min=1, max=65535)] = None,
    no_browser: Annotated[
        bool,
        typer.Option("--no-browser", help="ブラウザを自動で開かない"),
    ] = False,
) -> None:
    """Webアプリを起動し，準備完了後にブラウザを開く．"""

    settings, selected_host, selected_port = _server_settings(host, port)
    _warn_if_remote(selected_host)
    url = application_url(selected_host, selected_port)
    if is_paper_tools_ready(url):
        console.print(f"[OK] paper_tools は既に起動しています: {url}")
        if not no_browser:
            open_in_default_browser(url)
        return
    if not no_browser:
        schedule_browser_open(url)
        console.print("準備ができたらブラウザを自動で開きます．")
    console.print(f"paper_tools: {url}")
    console.print("このウィンドウを閉じるとアプリを停止します．")
    _run_server(settings, selected_host, selected_port, reload=False)


def _server_settings(
    host: str | None,
    port: int | None,
) -> tuple[AppSettings, str, int]:
    if host is not None:
        os.environ["PAPER_TOOLS_HOST"] = host
    if port is not None:
        os.environ["PAPER_TOOLS_PORT"] = str(port)
    if host is not None or port is not None:
        reset_settings_cache()
    settings = get_settings()
    selected_host = host or settings.host
    selected_port = port or settings.port
    return settings, selected_host, selected_port


def _warn_if_remote(host: str) -> None:
    if host not in {"127.0.0.1", "localhost", "::1"}:
        error_console.print(
            "[WARNING] 認証なしで待ち受けます．研究室LANでは0.0.0.0ではなく，"
            "信頼する端末から到達できる具体的なLANアドレスを指定してください．"
        )


def _run_server(settings: AppSettings, host: str, port: int, *, reload: bool) -> None:
    uvicorn.run(
        "paper_tools.app:create_app",
        factory=True,
        host=host,
        port=port,
        reload=reload,
        log_level="debug" if settings.debug else "info",
    )


@app.command()
def doctor(
    output_format: Annotated[str, typer.Option("--format", help="console / json")] = "console",
) -> None:
    """Python，SQLite，Typst，Ollama，設定，保存先を診断する．"""

    settings = get_settings()
    checks = run_doctor(settings)
    if output_format == "json":
        typer.echo(json.dumps([item.model_dump() for item in checks], ensure_ascii=False, indent=2))
    elif output_format == "console":
        table = Table(title="paper_tools 環境診断")
        table.add_column("状態")
        table.add_column("項目")
        table.add_column("詳細")
        for item in checks:
            label = {"ok": "[OK]", "error": "[ERROR]", "unavailable": "[N/A]"}.get(
                item.status, item.status
            )
            table.add_row(label, item.name, item.detail)
        console.print(table)
    else:
        _fail("--format は console または json を指定してください．")
    raise typer.Exit(doctor_exit_code(checks))


@app.command("init-db")
def init_db() -> None:
    """SQLiteデータベースと保存ディレクトリを初期化する．"""

    settings = get_settings()
    settings.ensure_directories()
    database = Database(settings)
    database.initialize()
    database.dispose()
    console.print(f"[OK] データベースを初期化しました: {settings.database_url}")


@app.command("templates")
def list_templates(
    output_format: Annotated[str, typer.Option("--format", help="console / json")] = "console",
) -> None:
    """利用可能な標準テンプレートを表示する．"""

    manifests = TemplateService().list_templates()
    if output_format == "json":
        typer.echo(
            json.dumps(
                [item.model_dump(mode="json") for item in manifests],
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if output_format != "console":
        _fail("--format は console または json を指定してください．")
    table = Table(title="標準テンプレート")
    table.add_column("ID")
    table.add_column("名称")
    table.add_column("言語")
    table.add_column("段組")
    for item in manifests:
        table.add_row(item.id, item.name, ", ".join(item.languages), str(item.columns))
    console.print(table)


@app.command()
def compile(
    project_id: Annotated[str, typer.Argument(help="プロジェクトID")],
) -> None:
    """指定プロジェクトのTypst原稿をPDFへコンパイルする．"""

    settings, database = _ready_database()
    try:
        with database.session() as session:
            result = PaperWorkflowService(session, settings).compile_project(project_id)
    except PaperToolsError as exc:
        database.dispose()
        _fail(str(exc))
    database.dispose()
    if result.success:
        console.print(f"[OK] PDFを生成しました: {result.output_path}")
        return
    for message in result.errors:
        error_console.print(f"[ERROR] {message}")
    raise typer.Exit(2)


@app.command()
def export(
    project_id: Annotated[str, typer.Argument(help="プロジェクトID")],
    output: Annotated[Path | None, typer.Option("--output", "-o", help="ZIP保存先")] = None,
) -> None:
    """プロジェクトを安全なZIPとしてエクスポートする．"""

    settings, database = _ready_database()
    try:
        with database.session() as session:
            ProjectService(session).get_project(project_id, aggregate=False)
            destination = ExportService(session, settings).export_project(project_id, output)
    except PaperToolsError as exc:
        database.dispose()
        _fail(str(exc))
    database.dispose()
    console.print(f"[OK] ZIPを保存しました: {destination}")


def _ready_database() -> tuple[AppSettings, Database]:
    settings = get_settings()
    settings.ensure_directories()
    database = Database(settings)
    database.initialize()
    return settings, database


def _fail(message: str) -> None:
    error_console.print(f"[ERROR] {message}")
    raise typer.Exit(2)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
