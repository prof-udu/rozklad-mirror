# -*- coding: utf-8 -*-
"""
sync.py — синхронізатор дзеркала розкладу УДУ імені Михайла Драгоманова.

Зчитує розклад із https://nmc.udu.edu.ua/cgi-bin/timetable.cgi і зберігає
його як набір статичних JSON-файлів у каталозі data/ репозиторію. Після
push на GitHub ці файли доступні через raw.githubusercontent.com / jsDelivr
і їх читають Telegram-бот (Cloudflare Workers) та статичний сайт — навіть
тоді, коли сервер університету вимкнений.

Запуск (з каталогу sync/):
    python3 sync.py --out ../data

Корисні опції:
    --from 07.11.2026 --to 31.01.2027   явний горизонт синхронізації
    --past-days 14 --future-days 75     горизонт відносно сьогодні
                                        (якщо --past-days не задано — від
                                        1 вересня навчального року)
    --groups dept|all                   які групи синхронізувати (типово dept —
                                        лише кафедра професійної освіти)
    --faculty 1005                      факультет для довідника викладачів
                                        (0 — весь університет)
    --delay 0.3                         пауза між запитами до сервера, сек
    --only "43ПОцт"                     синхронізувати лише вказані сутності
                                        (опція повторюється; шукайте за
                                        підрядком назви групи чи ПІБ)

Скрипт стійкий до збоїв: якщо сервер недоступний під час запуску
(блекаout), уже збережені файли НЕ видаляються — дзеркало лишається
з останніми вдалими даними, а в meta.json фіксується помилка.
"""

import argparse
import hashlib
import json
import logging
import sys
import time
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import timetable as tt

KYIV_TZ = ZoneInfo("Europe/Kyiv")
SCHEMA_VERSION = 1

logging.basicConfig(format="%(asctime)s [%(levelname)s] %(message)s",
                    level=logging.INFO)
logger = logging.getLogger("sync")


# ---------------------------------------------------------------------------
# Серіалізація
# ---------------------------------------------------------------------------

def entity_file(kind: str, name: str) -> str:
    """Детермінована назва файлу для сутності (кирилиця → sha1)."""
    digest = hashlib.sha1(f"{kind}:{name}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}-{digest}.json"


def lesson_to_json(ls: tt.Lesson) -> dict:
    d = {"n": ls.number, "ts": ls.time_start, "te": ls.time_end, "s": ls.subject}
    if ls.type:
        d["t"] = ls.type
    if ls.teacher:
        d["w"] = ls.teacher
    if ls.groups:
        d["g"] = ls.groups
    if ls.link:
        d["l"] = ls.link
    return d


def day_to_json(day: tt.Day) -> dict:
    return {"d": day.date.isoformat(), "wd": day.weekday,
            "lessons": [lesson_to_json(ls) for ls in day.lessons]}


def entity_to_json(kind: str, name: str, days: list) -> dict:
    return {"v": SCHEMA_VERSION, "kind": kind, "name": name,
            "days": [day_to_json(d) for d in days]}


# ---------------------------------------------------------------------------
# Головна логіка
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Синхронізація дзеркала розкладу УДУ")
    p.add_argument("--out", default="../data",
                   help="каталог призначення (data/ у репозиторії)")
    p.add_argument("--from", dest="date_from", default=None,
                   help="початок горизонту, дд.мм.рррр")
    p.add_argument("--to", dest="date_to", default=None,
                   help="кінець горизонту, дд.мм.рррр")
    p.add_argument("--past-days", type=int, default=None,
                   help="скільки днів назад охоплювати; якщо не задано — "
                        "від 1 вересня поточного навчального року")
    p.add_argument("--future-days", type=int, default=75,
                   help="скільки днів уперед охоплювати (типово 75)")
    p.add_argument("--groups", choices=["dept", "all"], default="dept",
                   help="dept — лише групи кафедри професійної освіти (типово); "
                        "all — усі групи довідника (уважно: сотні запитів)")
    p.add_argument("--faculty", default=None,
                   help="id факультету для довідника викладачів "
                        "(типово 1005 — технологій та дизайну; 0 — весь "
                        "університет, ~1200 викладачів)")
    p.add_argument("--delay", type=float, default=0.3,
                   help="пауза між запитами до сервера, сек (типово 0.3)")
    p.add_argument("--only", action="append", default=[],
                   help="синхронізувати лише сутності, що містять підрядок "
                        "(повторювана опція)")
    return p.parse_args()


def academic_year_start(today):
    """1 вересня навчального року, до якого належить дата today."""
    from datetime import date as _date
    return (_date(today.year, 9, 1) if today >= _date(today.year, 9, 1)
            else _date(today.year - 1, 9, 1))


def resolve_horizon(args) -> tuple:
    today = datetime.now(KYIV_TZ).date()
    if args.date_from and args.date_to:
        d1 = datetime.strptime(args.date_from, "%d.%m.%Y").date()
        d2 = datetime.strptime(args.date_to, "%d.%m.%Y").date()
    else:
        from datetime import timedelta
        # типово — від 1 вересня навчального року + майбутній період
        d1 = (today - timedelta(days=args.past_days)) if args.past_days is not None \
             else academic_year_start(today)
        d2 = today + timedelta(days=args.future_days)
    return d1, d2


def select_entities(args) -> list:
    """Повертає список (kind, name) для синхронізації."""
    entities = []
    if args.groups == "all":
        groups = tt.get_groups()
    else:
        groups = tt.get_department_groups()
    entities += [("group", g) for g in groups]
    entities += [("teacher", t) for t in tt.get_teachers()]
    if args.only:
        needles = [s.casefold() for s in args.only]
        entities = [(k, n) for k, n in entities
                    if any(s in n.casefold() for s in needles)]
    return entities


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)


def main() -> int:
    args = parse_args()
    if args.faculty is not None:
        tt.FACULTY_ID = args.faculty
    out = Path(args.out).resolve()
    sched_dir = out / "schedules"
    started = time.time()

    try:
        date_from, date_to = resolve_horizon(args)
    except ValueError:
        logger.error("Невірний формат дати. Використовуйте дд.мм.рррр.")
        return 2

    # --- довідники та перелік сутностей ------------------------------------
    try:
        entities = select_entities(args)
    except tt.SiteError as exc:
        logger.error("Сервер розкладу недоступний: %s", exc)
        logger.error("Дзеркало НЕ оновлено — лишаються дані останньої вдалої "
                     "синхронізації. Спробуйте пізніше.")
        return 1
    logger.info("Горизонт: %s — %s. Сутностей: %d",
                date_from, date_to, len(entities))

    # --- синхронізація кожної сутності --------------------------------------
    index_groups, index_teachers = [], []
    ok, empty, failed = 0, 0, 0
    expected_files = set()

    for i, (kind, name) in enumerate(entities, 1):
        fname = entity_file(kind, name)
        expected_files.add(fname)
        try:
            days = tt.get_schedule(kind, name, date_from, date_to)
        except tt.NoDataError:
            days = []
            empty += 1
        except tt.SiteError as exc:
            failed += 1
            logger.warning("[%d/%d] %s «%s»: ПРОПУЩЕНО (%s). "
                           "Лишається попередня версія файлу.",
                           i, len(entities), kind, name, exc)
            continue
        write_json(sched_dir / fname, entity_to_json(kind, name, days))
        ok += 1
        entry = {"n": name, "f": fname}
        (index_groups if kind == "group" else index_teachers).append(entry)
        logger.info("[%d/%d] %s «%s»: днів із заняттями %d",
                    i, len(entities), kind, name, len(days))
        if i < len(entities):
            time.sleep(args.delay)

    # --- прибрати застарілі файли, яких немає в поточному наборі ------------
    removed = 0
    if not args.only and sched_dir.exists():
        for old in sched_dir.glob("*.json"):
            if old.name not in expected_files:
                old.unlink()
                removed += 1

    # --- індекси та метадані -------------------------------------------------
    if not args.only:  # частковий запуск не переписує індекси
        write_json(out / "groups.json", index_groups)
        write_json(out / "teachers.json", index_teachers)
        write_json(out / "meta.json", {
            "v": SCHEMA_VERSION,
            "updated_at": datetime.now(KYIV_TZ).isoformat(timespec="seconds"),
            "tz": "Europe/Kyiv",
            "from": date_from.isoformat(),
            "to": date_to.isoformat(),
            "groups": len(index_groups),
            "teachers": len(index_teachers),
            "failed": failed,
            "source": "https://nmc.udu.edu.ua/cgi-bin/timetable.cgi",
        })

    logger.info("Готово за %.1f с: оновлено %d, без занять %d, "
                "помилок %d, видалено застарілих %d.",
                time.time() - started, ok, empty, failed, removed)
    if failed:
        logger.warning("Були помилки звернення до сервера — частина файлів "
                       "лишилася з попередніх даних.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
