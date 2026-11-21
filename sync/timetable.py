# -*- coding: utf-8 -*-
"""
timetable.py — клієнт системи електронного розкладу УДУ імені Михайла Драгоманова
(https://nmc.udu.edu.ua/cgi-bin/timetable.cgi) для синхронізатора дзеркала.

Відмінності від версії з Telegram-бота:
  * парсинг використовує семантичну розмітку сайту (span.p_name / p_type_name /
    gr2_name у вигляді групи, gr_name у вигляді викладача, t_name), тому
    коректно витягує тип заняття, викладача та групи;
  * підтримує кілька занять в одній комірці (підгрупи, збірні групи);
  * без кешування — синхронізатор завжди хоче свіжі дані.

Особливості сайту:
  * кодування сторінок — windows-1251 (cp1251): і запити, і відповіді;
  * розклад повертається лише на POST-запит (n=700);
  * у сайта недійсний SSL-сертифікат, тому перевірку вимкнено (verify=False);
  * дні без занять у відповіді відсутні;
  * якщо за весь діапазон занять немає — текст «За вашим запитом записів не знайдено».
"""

import os
import re
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

import requests
import urllib3
from bs4 import BeautifulSoup

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://nmc.udu.edu.ua/cgi-bin/timetable.cgi"
# Факультет технологій та дизайну. Для дзеркала всього університету задайте
# змінну середовища ROZKLAD_FACULTY=0 (довідник викладачів стане загальним,
# ~1200 осіб; довідник груп і так універсальний — ~830 груп).
FACULTY_ID = os.environ.get("ROZKLAD_FACULTY", "1005")
ENCODING = "cp1251"
REQUEST_TIMEOUT = 45

# Групи кафедри професійної освіти:
#   ПОцт / ПОМцт — «Професійна освіта. Цифрові технології»
#   ПОхт / ПОМхт — «Професійна освіта. Харчові технології»
DEPT_GROUP_RE = re.compile(r"ПОМ?[цх]т", re.IGNORECASE)

NO_DATA_MARKER = "За вашим запитом записів не знайдено"

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Моделі даних
# ---------------------------------------------------------------------------

@dataclass
class Lesson:
    number: str = ""       # номер пари (1..8)
    time_start: str = ""   # "08:00"
    time_end: str = ""     # "09:20"
    subject: str = ""      # назва дисципліни
    type: str = ""         # тип заняття: "Л", "Пр", "Лаб", "Сем" ...
    teacher: str = ""      # викладач (span.t_name), напр. "доц. Іваненко О.П."
    groups: str = ""       # групи (span.gr2_name), напр. "зб.гр. 20ом, 23ПОцт"
    link: str = ""         # посилання на Meet/Zoom тощо (якщо є)


@dataclass
class Day:
    date: date
    weekday: str           # "Понеділок"
    lessons: list = field(default_factory=list)


class NoDataError(Exception):
    """Система не має даних за вказаний запит/період."""


class SiteError(Exception):
    """Технічна помилка звернення до сайту розкладу."""


# ---------------------------------------------------------------------------
# Низькорівневі запити
# ---------------------------------------------------------------------------

def _post(params: dict) -> str:
    """POST-запит до timetable.cgi з кодуванням cp1251. Повертає текст сторінки."""
    body = "&".join(
        f"{k}={requests.utils.quote(str(v), safe='', encoding=ENCODING)}"
        for k, v in params.items()
    ).encode("ascii")
    try:
        resp = requests.post(
            f"{BASE_URL}?n=700",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "Mozilla/5.0 (ScheduleMirror)"},
            timeout=REQUEST_TIMEOUT,
            verify=False,
        )
    except requests.RequestException as exc:
        raise SiteError(f"Не вдалося з'єднатися з сервером розкладу: {exc}") from exc
    resp.encoding = ENCODING
    return resp.text


def _get_json_suggestions(lev: int) -> list:
    """Отримати перелік (lev=141 викладачі, lev=142 групи)."""
    try:
        resp = requests.get(
            BASE_URL,
            params={"n": "701", "lev": str(lev), "faculty": FACULTY_ID,
                    "course": "0", "query": ""},
            headers={"User-Agent": "Mozilla/5.0 (ScheduleMirror)"},
            timeout=REQUEST_TIMEOUT,
            verify=False,
        )
    except requests.RequestException as exc:
        raise SiteError(f"Не вдалося отримати довідник: {exc}") from exc
    resp.encoding = ENCODING
    m = re.search(r'"suggestions"\s*:\s*\[(.*)\]', resp.text, re.S)
    if not m:
        return []
    return re.findall(r'"([^"]*)"', m.group(1))


# Службові записи в довіднику викладачів, які не є ПІБ («Вакансія 3 11 11»)
VACANCY_RE = re.compile(r"^\s*вакансі", re.IGNORECASE)


def get_teachers() -> list:
    """ПІБ викладачів факультету (або всього університету при FACULTY_ID=0),
    без службових записів «Вакансія …»."""
    return [t for t in _get_json_suggestions(141) if not VACANCY_RE.search(t)]


def get_groups() -> list:
    return _get_json_suggestions(142)


def get_department_groups() -> list:
    """Групи кафедри професійної освіти (цифрові та харчові технології)."""
    return sorted(g for g in get_groups() if DEPT_GROUP_RE.search(g))


# ---------------------------------------------------------------------------
# Парсинг HTML розкладу
# ---------------------------------------------------------------------------

_DAY_HEADER_RE = re.compile(
    r"<h4>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<small>([^<]+)</small>\s*</h4>",
    re.IGNORECASE,
)


def _parse_lesson_cell(td) -> list:
    """Розібрати комірку із заняттям. Повертає список Lesson (може бути
    кілька занять у комірці — підгрупи/збірні групи).

    Основний шлях — семантичні span-и сайту. Якщо їх немає (спрощена
    розмітка), використовується текстовий розбір за <br>.
    """
    if not td.decode_contents().strip():
        return []

    # --- семантичний розбір -------------------------------------------------
    if td.find("span", class_="p_name"):
        lessons, cur = [], None
        for el in td.descendants:
            if getattr(el, "name", None) == "span":
                cls = el.get("class") or []
                text = el.get_text(" ", strip=True)
                if "p_name" in cls:
                    cur = Lesson(subject=text)
                    lessons.append(cur)
                elif cur is not None and "p_type_name" in cls:
                    cur.type = text
                elif cur is not None and ("gr2_name" in cls or "gr_name" in cls):
                    # gr2_name — у вигляді групи, gr_name — у вигляді викладача
                    cur.groups = (cur.groups + " " + text).strip()
                elif cur is not None and "t_name" in cls:
                    cur.teacher = (cur.teacher + " " + text).strip()
            elif getattr(el, "name", None) == "a" and el.get("href") and cur is not None:
                if not cur.link:
                    cur.link = el["href"].strip()
        return [ls for ls in lessons if ls.subject]

    # --- запасний текстовий розбір -----------------------------------------
    a = td.find("a", href=True)
    link = a["href"].strip() if a else ""
    for br in td.find_all("br"):
        br.replace_with("\n")
    for div in td.find_all("div"):
        div.extract()  # прибираємо div.link зі скороченим посиланням
    lines = [ln.strip() for ln in td.get_text("\n").splitlines() if ln.strip()]
    if not lines:
        return []
    return [Lesson(subject=lines[0], teacher=lines[1] if len(lines) > 1 else "",
                   link=link)]


def parse_schedule_html(html: str) -> list:
    """Повертає список Day з HTML-сторінки розкладу.

    Сайт генерує невалідний HTML (рядки <tr> поза <table>, незакриті div),
    тому сторінку спочатку розрізаємо на блоки за заголовками днів
    «<h4>дд.мм.рррр <small>День тижня</small></h4>», а потім у кожному блоці
    шукаємо всі рядки <tr> незалежно від вкладеності.
    """
    if NO_DATA_MARKER in html:
        raise NoDataError()
    matches = list(_DAY_HEADER_RE.finditer(html))
    days = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(html)
        chunk = html[m.end():end]
        day = Day(date=date(int(m.group(3)), int(m.group(2)), int(m.group(1))),
                  weekday=m.group(4).strip())
        soup = BeautifulSoup(chunk, "html.parser")
        for tr in soup.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 3:
                continue
            lessons = _parse_lesson_cell(tds[2])
            if not lessons:
                continue
            times = [t.strip() for t in tds[1].get_text("\n").splitlines() if t.strip()]
            for lesson in lessons:
                lesson.number = tds[0].get_text(strip=True)
                if len(times) >= 2:
                    lesson.time_start, lesson.time_end = times[0], times[1]
            day.lessons.extend(lessons)
        days.append(day)
    return days


# ---------------------------------------------------------------------------
# Завантаження розкладу
# ---------------------------------------------------------------------------

def get_schedule(kind: str, name: str, date_from: date, date_to: date) -> list:
    """
    kind: "group" або "teacher"; name: назва групи або ПІБ викладача.
    Повертає список Day (лише дні, в які є заняття).
    Кидає NoDataError, якщо даних немає, SiteError — при збої сайту.
    """
    params = {
        "faculty": FACULTY_ID,
        "teacher": name if kind == "teacher" else "",
        "course": "0",
        "group": name if kind == "group" else "",
        "sdate": date_from.strftime("%d.%m.%Y"),
        "edate": date_to.strftime("%d.%m.%Y"),
        "n": "700",
    }
    html = _post(params)
    return parse_schedule_html(html)


# ---------------------------------------------------------------------------
# Допоміжні функції дат
# ---------------------------------------------------------------------------

UKR_WEEKDAYS = ["Понеділок", "Вівторок", "Середа",
                "Четвер", "П'ятниця", "Субота", "Неділя"]


def week_bounds(d: date) -> tuple:
    """Понеділок і неділя тижня, що містить дату d."""
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)
