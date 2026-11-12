#!/usr/bin/env python3
"""Load the tables the stats backfill needs from a mysqldump/mariadb-dump .sql into SQLite.

Usage: load-wp-dump.py dump.sql[.gz] out.db
Only the WP Statistics tables plus posts/terms/options are kept. The output holds visitor
hashes and user rows: keep it (and the dump) out of the repo.
"""
import gzip, os, re, sqlite3, sys

WANT = {"wp_statistics_visitor", "wp_statistics_visit", "wp_statistics_pages", "wp_statistics_search",
        "wp_statistics_visitor_relationships", "wp_posts", "wp_options", "wp_terms", "wp_term_taxonomy"}
ESC = {"0": "\0", "n": "\n", "r": "\r", "t": "\t", "Z": "\x1a", "b": "\b"}


def parse_values(s):
    i, n, rows = 0, len(s), []
    while i < n:
        while i < n and s[i] in " ,\n":
            i += 1
        if i >= n or s[i] == ";":
            break
        assert s[i] == "(", s[i:i + 50]
        i += 1
        row = []
        while True:
            c = s[i]
            if c == "'":
                i += 1
                buf = []
                while True:
                    c = s[i]
                    if c == "\\":
                        buf.append(ESC.get(s[i + 1], s[i + 1]))
                        i += 2
                    elif c == "'":
                        if s[i + 1:i + 2] == "'":
                            buf.append("'")
                            i += 2
                        else:
                            i += 1
                            break
                    else:
                        buf.append(c)
                        i += 1
                row.append("".join(buf))
            else:
                j = i
                while s[j] not in ",)":
                    j += 1
                tok = s[i:j]
                i = j
                if tok == "NULL":
                    row.append(None)
                else:
                    try:
                        row.append(int(tok))
                    except ValueError:
                        row.append(float(tok))
            if s[i] == ",":
                i += 1
                continue
            if s[i] == ")":
                i += 1
                break
        rows.append(row)
    return rows


def main(src, out):
    opener = gzip.open if src.endswith(".gz") else open
    txt = opener(src, "rt", encoding="utf8", errors="replace").read()
    cols = {}
    for m in re.finditer(r"^CREATE TABLE `(\w+)` \((.*?)^\) ENGINE", txt, re.S | re.M):
        if m.group(1) in WANT:
            cols[m.group(1)] = [re.match(r"\s*`(\w+)`", l).group(1) for l in m.group(2).split("\n") if re.match(r"\s*`\w+` ", l)]
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    for t, c in cols.items():
        db.execute(f"create table {t} ({','.join(c)})")
    counts = {}
    # Statements end with ";" on their own line end; the lookahead keeps ";\n" inside post content from splitting one.
    for m in re.finditer(r"^INSERT INTO `(\w+)` VALUES\s*\n?(.*?);\n(?=UNLOCK TABLES|INSERT INTO|/\*|--)", txt, re.M | re.S):
        t = m.group(1)
        if t not in cols:
            continue
        rows = parse_values(m.group(2) + ";")
        db.executemany(f"insert into {t} values ({','.join('?' * len(cols[t]))})", rows)
        counts[t] = counts.get(t, 0) + len(rows)
    db.commit()
    os.chmod(out, 0o600)
    print(counts)


if __name__ == "__main__":
    main(*sys.argv[1:3])
