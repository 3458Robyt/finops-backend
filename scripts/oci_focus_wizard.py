#!/usr/bin/env python3
"""
Guided OCI FOCUS bootstrap.

This script is a safer alternative to browser UI automation. It can launch the
official OCI CLI browser authentication flow, then uses OCI CLI/API calls to
validate access to FOCUS Cost Reports.

It does not read, store, or print secrets.
"""

from __future__ import annotations

import argparse
import calendar
import configparser
import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ORACLE_USAGE_REPORT_TENANCY_OCID = (
    "ocid1.tenancy.oc1..aaaaaaaaned4fkpkisbwjlr56u7cj63lf3wffbilvqknstgtvzub7vhqkggq"
)
REPORTING_NAMESPACE = "bling"
DEFAULT_PREFIX = "FOCUS Reports"


class WizardError(RuntimeError):
    pass


def extract_object_list(data: Any) -> list[dict[str, Any]]:
    response_data = data.get("data", data) if isinstance(data, dict) else data

    if isinstance(response_data, dict):
        objects = response_data.get("objects", [])
    elif isinstance(response_data, list):
        objects = response_data
    else:
        objects = []

    return [obj for obj in objects if isinstance(obj, dict)]


def safe_object_download_path(download_dir: Path, tenancy_id: str, object_name: str) -> Path:
    parts = [part for part in object_name.replace("\\", "/").split("/") if part not in {"", ".", ".."}]
    if not parts:
        raise WizardError(f"Nombre de objeto OCI invalido para descarga: {object_name}")

    destination = download_dir / tenancy_id
    for part in parts:
        destination = destination / part

    resolved_base = (download_dir / tenancy_id).resolve()
    resolved_destination = destination.resolve()
    if not str(resolved_destination).startswith(str(resolved_base)):
        raise WizardError(f"Ruta de descarga insegura para objeto OCI: {object_name}")

    return destination


def parse_date_arg(value: str, label: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise WizardError(f"{label} debe tener formato YYYY-MM-DD. Valor recibido: {value}") from exc


def subtract_months(value: date, months: int) -> date:
    if months < 0:
        raise WizardError("--months-back no puede ser negativo.")

    year = value.year
    month = value.month - months
    while month <= 0:
        month += 12
        year -= 1

    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(value.day, last_day))


def resolve_date_range(
    start_date_arg: str | None,
    end_date_arg: str | None,
    months_back: int | None,
    days_back: int | None,
) -> tuple[date, date]:
    if months_back is not None and days_back is not None:
        raise WizardError("Usa solo uno: --months-back o --days-back.")

    end_date = parse_date_arg(end_date_arg, "--end-date") if end_date_arg else datetime.now(timezone.utc).date()

    if start_date_arg:
        start_date = parse_date_arg(start_date_arg, "--start-date")
    elif months_back is not None:
        start_date = subtract_months(end_date, months_back)
    elif days_back is not None:
        if days_back < 0:
            raise WizardError("--days-back no puede ser negativo.")
        start_date = end_date - timedelta(days=days_back)
    else:
        start_date = end_date

    if start_date > end_date:
        raise WizardError("--start-date no puede ser posterior a --end-date.")

    return start_date, end_date


def iter_month_include_patterns(prefix: str, start_date: date, end_date: date) -> list[str]:
    base_prefix = prefix.rstrip("/")
    current = date(start_date.year, start_date.month, 1)
    last = date(end_date.year, end_date.month, 1)
    patterns: list[str] = []

    while current <= last:
        patterns.append(f"{base_prefix}/{current:%Y/%m}/*")
        if current.month == 12:
            current = date(current.year + 1, 1, 1)
        else:
            current = date(current.year, current.month + 1, 1)

    return patterns


def prompt(message: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{message}{suffix}: ").strip()
    return value or (default or "")


def prompt_yes_no(message: str, default: bool = False) -> bool:
    default_text = "s" if default else "n"
    value = input(f"{message} [s/n, default {default_text}]: ").strip().lower()
    if not value:
        return default
    return value in {"s", "si", "y", "yes"}


def find_oci_cli() -> str | None:
    found = shutil.which("oci")
    if found:
        return found

    candidates = [
        Path.home() / "bin" / "oci.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Oracle" / "oci-cli" / "oci.exe",
        Path("C:/Program Files/Oracle/oci-cli/oci.exe"),
        Path("C:/Program Files (x86)/Oracle/oci-cli/oci.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return None


def require_oci_cli() -> str:
    oci_cli = find_oci_cli()
    if oci_cli is None:
        raise WizardError(
            "OCI CLI no esta instalado o no esta en PATH. Instala OCI CLI antes de continuar: "
            "https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm"
        )
    return oci_cli


def run_command(args: list[str], *, allow_live_output: bool = False) -> subprocess.CompletedProcess[str]:
    if allow_live_output:
        return subprocess.run(args, text=True, check=False)

    completed = subprocess.run(
        args,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return completed


def build_oci_args(args: list[str], profile: str, auth: str, oci_cli: str, *, output_json: bool) -> list[str]:
    final_args = [oci_cli, *args, "--profile", profile]
    if auth != "api_key":
        final_args.extend(["--auth", auth])
    if output_json:
        final_args.extend(["--output", "json"])
    return final_args


def run_oci_json(args: list[str], profile: str, auth: str, oci_cli: str) -> Any:
    final_args = build_oci_args(args, profile, auth, oci_cli, output_json=True)
    completed = run_command(final_args)
    if completed.returncode != 0:
        command = " ".join(final_args)
        output = ((completed.stderr or completed.stdout) or "").strip()
        raise WizardError(f"Fallo OCI CLI:\n{command}\n\n{output}")

    output = completed.stdout.strip()
    if not output:
        return None

    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise WizardError(f"OCI CLI no devolvio JSON valido:\n{output}") from exc


def run_oci(
    args: list[str],
    profile: str,
    auth: str,
    oci_cli: str,
    *,
    allow_live_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    final_args = build_oci_args(args, profile, auth, oci_cli, output_json=False)
    completed = run_command(final_args, allow_live_output=allow_live_output)
    if completed.returncode != 0:
        command = " ".join(final_args)
        output = (completed.stderr or completed.stdout).strip()
        raise WizardError(f"Fallo OCI CLI:\n{command}\n\n{output}")
    return completed


def config_path() -> Path:
    return Path.home() / ".oci" / "config"


def load_profile(profile: str) -> dict[str, str]:
    path = config_path()
    if not path.exists():
        return {}

    parser = configparser.ConfigParser()
    parser.read(path)

    if not parser.has_section(profile):
        return {}

    return {key: value for key, value in parser.items(profile)}


def authenticate_with_browser(profile: str, region: str, oci_cli: str) -> None:
    print("")
    print("Se abrira el login oficial de OCI CLI en el navegador.")
    print("Completa el login/MFA en OCI. Este script no ve tu contrasena ni tokens.")
    print("")

    completed = run_command(
        [
            oci_cli,
            "session",
            "authenticate",
            "--region",
            region,
            "--profile-name",
            profile,
        ],
        allow_live_output=True,
    )

    if completed.returncode != 0:
        raise WizardError("No se pudo completar 'oci session authenticate'.")


def get_profile_tenancy(profile: str, explicit_tenancy_id: str | None) -> str:
    if explicit_tenancy_id:
        return explicit_tenancy_id

    profile_data = load_profile(profile)
    tenancy_id = profile_data.get("tenancy")
    if tenancy_id:
        return tenancy_id

    raise WizardError(
        f"No encontre 'tenancy' en el perfil OCI '{profile}'. "
        "Pasa --tenancy-id o ejecuta autenticacion primero."
    )


def print_required_policy(group_name: str | None = None) -> None:
    target_group = group_name or "<grupo_oci>"
    print("")
    print("Politica IAM requerida para leer OCI Cost Reports:")
    print(f"  define tenancy usage-report as {ORACLE_USAGE_REPORT_TENANCY_OCID}")
    print(f"  endorse group {target_group} to read objects in tenancy usage-report")


def validate_tenancy(profile: str, auth: str, tenancy_id: str, oci_cli: str) -> None:
    try:
        data = run_oci_json(["iam", "tenancy", "get", "--tenancy-id", tenancy_id], profile, auth, oci_cli)
    except WizardError as exc:
        print("")
        print("Aviso: no pude validar metadata de la tenancy, pero continuare.")
        print(str(exc))
        return

    tenancy = data.get("data", {}) if isinstance(data, dict) else {}
    tenancy_name = tenancy.get("name")
    if tenancy_name:
        print(f"[OK] Autenticado contra tenancy: {tenancy_name}")
    else:
        print("[OK] Autenticado contra tenancy.")


def ensure_policy(profile: str, auth: str, tenancy_id: str, group_name: str, policy_name: str, oci_cli: str) -> None:
    statements = [
        f"define tenancy usage-report as {ORACLE_USAGE_REPORT_TENANCY_OCID}",
        f"endorse group {group_name} to read objects in tenancy usage-report",
    ]

    print("")
    print(f"Verificando politica IAM '{policy_name}'...")

    data = run_oci_json(
        ["iam", "policy", "list", "--compartment-id", tenancy_id, "--all"],
        profile,
        auth,
        oci_cli,
    )
    policies = data.get("data", []) if isinstance(data, dict) else []
    for policy in policies:
        if policy.get("name") == policy_name:
            print(f"[OK] La politica ya existe: {policy_name}")
            return

    print(f"Creando politica IAM '{policy_name}' para el grupo '{group_name}'...")
    created = run_oci_json(
        [
            "iam",
            "policy",
            "create",
            "--compartment-id",
            tenancy_id,
            "--name",
            policy_name,
            "--description",
            "Allows FinOps ingestion to read OCI FOCUS Cost Reports.",
            "--statements",
            json.dumps(statements),
        ],
        profile,
        auth,
        oci_cli,
    )

    created_policy = created.get("data", {}) if isinstance(created, dict) else {}
    print(f"[OK] Politica creada: {policy_name}")
    if created_policy.get("id"):
        print(f"     OCID: {created_policy['id']}")


def get_focus_report_objects(profile: str, auth: str, tenancy_id: str, prefix: str, limit: int, oci_cli: str) -> list[dict[str, Any]]:
    data = run_oci_json(
        [
            "os",
            "object",
            "list",
            "--namespace-name",
            REPORTING_NAMESPACE,
            "--bucket-name",
            tenancy_id,
            "--prefix",
            prefix,
            "--limit",
            str(limit),
        ],
        profile,
        auth,
        oci_cli,
    )

    return extract_object_list(data)


def printable_report_rows(objects: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    rows = []
    for obj in objects[:limit]:
        name = obj.get("name", "")
        if not name:
            continue

        rows.append(
            {
                "name": name,
                "size": obj.get("size", ""),
                "time_created": obj.get("time-created") or obj.get("timeCreated") or "",
            }
        )

    return sorted(rows, key=lambda row: str(row["time_created"]), reverse=True)


def list_focus_reports(profile: str, auth: str, tenancy_id: str, prefix: str, limit: int, oci_cli: str) -> list[dict[str, Any]]:
    print("")
    print("Listando OCI FOCUS Cost Reports...")
    print(f"  namespace: {REPORTING_NAMESPACE}")
    print(f"  bucket:    {tenancy_id}")
    print(f"  prefix:    {prefix}")

    objects = get_focus_report_objects(profile, auth, tenancy_id, prefix, limit, oci_cli)

    if not objects:
        print("")
        print("No se encontraron reportes FOCUS.")
        print("Revisa home region, estado de facturacion y politica IAM.")
        return []

    rows = printable_report_rows(objects, limit)

    if not rows:
        print("")
        print("OCI devolvio objetos, pero ninguno tenia nombre interpretable.")
        print("Ejecuta de nuevo con OCI CLI directo para revisar la forma de la respuesta.")
        return []

    width = min(max(len(row["name"]) for row in rows), 100)
    print("")
    print(f"{'Name':{width}}  {'SizeBytes':>12}  TimeCreated")
    print(f"{'-' * width}  {'-' * 12}  {'-' * 24}")
    for row in rows:
        name = row["name"]
        if len(name) > width:
            name = "..." + name[-(width - 3):]
        print(f"{name:{width}}  {str(row['size']):>12}  {row['time_created']}")

    print("")
    print("[OK] Acceso a OCI FOCUS Cost Reports funcionando.")
    return rows


def download_focus_reports(
    rows: list[dict[str, Any]],
    profile: str,
    auth: str,
    tenancy_id: str,
    download_dir: Path,
    overwrite: bool,
    oci_cli: str,
) -> None:
    if not rows:
        return

    print("")
    print(f"Descargando {len(rows)} reporte(s) OCI FOCUS...")
    print(f"  destino: {download_dir}")

    for row in rows:
        object_name = str(row["name"])
        destination = safe_object_download_path(download_dir, tenancy_id, object_name)
        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists():
            if not overwrite:
                print(f"[SKIP] Ya existe: {destination}")
                continue
            destination.unlink()

        run_oci(
            [
                "os",
                "object",
                "get",
                "--namespace-name",
                REPORTING_NAMESPACE,
                "--bucket-name",
                tenancy_id,
                "--name",
                object_name,
                "--file",
                str(destination),
            ],
            profile,
            auth,
            oci_cli,
        )
        print(f"[OK] Descargado: {destination}")


def bulk_download_focus_reports(
    prefix: str,
    profile: str,
    auth: str,
    tenancy_id: str,
    download_dir: Path,
    overwrite: bool,
    parallel_operations_count: int,
    dry_run: bool,
    include_patterns: list[str],
    oci_cli: str,
) -> None:
    download_dir.mkdir(parents=True, exist_ok=True)

    print("")
    print("Descarga masiva OCI FOCUS")
    print(f"  prefijo:  {prefix}")
    print(f"  destino:  {download_dir}")
    print(f"  paralelo: {parallel_operations_count}")
    if include_patterns:
        print(f"  filtros:  {len(include_patterns)} patron(es) mensual(es)")
    if dry_run:
        print("  modo:     dry-run")

    command = [
        "os",
        "object",
        "bulk-download",
        "--namespace-name",
        REPORTING_NAMESPACE,
        "--bucket-name",
        tenancy_id,
        "--download-dir",
        str(download_dir),
        "--prefix",
        prefix,
        "--parallel-operations-count",
        str(parallel_operations_count),
    ]

    for pattern in include_patterns:
        command.extend(["--include", pattern])

    command.append("--overwrite" if overwrite else "--no-overwrite")

    if dry_run:
        command.append("--dry-run")

    run_oci(command, profile, auth, oci_cli, allow_live_output=True)

    print("")
    print("[OK] Descarga masiva finalizada.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wizard para configurar/validar OCI FOCUS Cost Reports.")
    parser.add_argument("--profile", default=None, help="Perfil OCI CLI. Default interactivo: finops-oci.")
    parser.add_argument(
        "--auth",
        choices=["api_key", "security_token", "instance_principal", "resource_principal"],
        default=None,
        help="Metodo de auth OCI CLI. Default interactivo: security_token.",
    )
    parser.add_argument("--region", default=None, help="Region home para 'oci session authenticate'.")
    parser.add_argument("--tenancy-id", default=None, help="OCID de la tenancy si no esta en el perfil.")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help="Prefijo de reportes. Default: FOCUS Reports.")
    parser.add_argument("--limit", type=int, default=10, help="Maximo de objetos a listar.")
    parser.add_argument("--download", action="store_true", help="Descarga los reportes listados.")
    parser.add_argument("--bulk-download", action="store_true", help="Usa una sola llamada a OCI CLI bulk-download.")
    parser.add_argument(
        "--download-dir",
        default=str(Path("downloads") / "oci-focus"),
        help="Carpeta local para descargas. Default: downloads/oci-focus.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Sobrescribe archivos ya descargados.")
    parser.add_argument("--dry-run", action="store_true", help="Muestra que descargaria sin bajar archivos. Solo aplica a --bulk-download.")
    parser.add_argument("--start-date", default=None, help="Fecha inicial YYYY-MM-DD para filtro mensual de bulk-download.")
    parser.add_argument("--end-date", default=None, help="Fecha final YYYY-MM-DD para filtro mensual de bulk-download. Default: hoy UTC.")
    parser.add_argument("--months-back", type=int, default=None, help="Incluye meses desde N meses atras hasta --end-date/hoy.")
    parser.add_argument("--days-back", type=int, default=None, help="Calcula meses a incluir desde N dias atras hasta --end-date/hoy.")
    parser.add_argument(
        "--parallel-operations-count",
        type=int,
        default=25,
        help="Paralelismo para OCI bulk-download. Default: 25.",
    )
    parser.add_argument("--group-name", default=None, help="Grupo OCI para crear politica.")
    parser.add_argument("--policy-name", default="FinOpsFocusReportReadPolicy", help="Nombre de politica IAM.")
    parser.add_argument("--login", "--browser-login", action="store_true", help="Abre login oficial de OCI CLI en navegador.")
    parser.add_argument("--create-policy", action="store_true", help="Crea politica IAM minima.")
    parser.add_argument("--skip-list", action="store_true", help="No lista reportes FOCUS.")
    parser.add_argument("--non-interactive", action="store_true", help="No pregunta nada.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        oci_cli = require_oci_cli()

        if args.non_interactive:
            profile = args.profile or ("finops-oci" if args.login else "DEFAULT")
            auth = args.auth or ("security_token" if args.login else "api_key")
            do_login = args.login
            do_create_policy = args.create_policy
        else:
            print("OCI FOCUS wizard")
            print("")
            print("Este flujo evita automatizar clicks del navegador.")
            print("Usa el login oficial de OCI CLI si necesitas autenticarte con navegador.")
            print("")

            profile = args.profile or prompt("Perfil OCI CLI a usar/crear", "finops-oci")
            auth = args.auth or prompt("Auth OCI CLI: api_key o security_token", "security_token")
            do_login = args.login or prompt_yes_no("Quieres abrir login oficial de OCI CLI en navegador?", True)
            do_create_policy = args.create_policy or prompt_yes_no("Quieres crear/verificar la politica IAM minima?", False)

        if do_login:
            region = args.region
            if not region and not args.non_interactive:
                region = prompt("Home region OCI, ejemplo sa-bogota-1 o us-ashburn-1")
            if not region:
                raise WizardError("--region es requerido para --browser-login.")
            authenticate_with_browser(profile, region, oci_cli)
            auth = "security_token"

        tenancy_id = get_profile_tenancy(profile, args.tenancy_id)

        print("")
        print("Configuracion detectada:")
        print(f"  profile: {profile}")
        print(f"  auth:    {auth}")
        print(f"  tenancy: {tenancy_id}")

        validate_tenancy(profile, auth, tenancy_id, oci_cli)

        group_name = args.group_name
        if do_create_policy and not group_name and not args.non_interactive:
            group_name = prompt("Nombre exacto del grupo OCI que leera Cost Reports")
        if do_create_policy:
            if not group_name:
                raise WizardError("--group-name es requerido para --create-policy.")
            print_required_policy(group_name)
            ensure_policy(profile, auth, tenancy_id, group_name, args.policy_name, oci_cli)
        else:
            print_required_policy(group_name)
            print("")
            print("No se hicieron cambios IAM. Usa --create-policy si quieres crear la politica.")

        if args.parallel_operations_count < 1 or args.parallel_operations_count > 1000:
            raise WizardError("--parallel-operations-count debe estar entre 1 y 1000.")

        if args.bulk_download:
            include_patterns: list[str] = []
            has_date_filter = (
                args.start_date is not None
                or args.end_date is not None
                or args.months_back is not None
                or args.days_back is not None
            )
            if has_date_filter:
                start_date, end_date = resolve_date_range(
                    args.start_date,
                    args.end_date,
                    args.months_back,
                    args.days_back,
                )
                include_patterns = iter_month_include_patterns(args.prefix, start_date, end_date)
                print("")
                print(
                    "Rango bulk-download aproximado por meses: "
                    f"{start_date.isoformat()} a {end_date.isoformat()} "
                    f"({len(include_patterns)} mes(es) en una sola llamada)"
                )
                print("Nota: para evitar descargas por dia, los meses frontera pueden incluir dias fuera del rango exacto.")

            bulk_download_focus_reports(
                args.prefix,
                profile,
                auth,
                tenancy_id,
                Path(args.download_dir),
                args.overwrite,
                args.parallel_operations_count,
                args.dry_run,
                include_patterns,
                oci_cli,
            )
            rows = []
        else:
            rows: list[dict[str, Any]] = []

        if not args.bulk_download and (not args.skip_list or args.download):
            rows = list_focus_reports(profile, auth, tenancy_id, args.prefix, args.limit, oci_cli)

        if args.download and not args.bulk_download:
            download_focus_reports(
                rows,
                profile,
                auth,
                tenancy_id,
                Path(args.download_dir),
                args.overwrite,
                oci_cli,
            )

        print("")
        print("Wizard finalizado.")
        return 0

    except KeyboardInterrupt:
        print("")
        print("Cancelado por el usuario.")
        return 130
    except WizardError as exc:
        print("")
        print(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
