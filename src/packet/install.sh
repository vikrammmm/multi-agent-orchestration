#!/usr/bin/env bash
# macOS and Linux installer for the delegation team packet (bash 3.2+)
# shellcheck shell=bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── helpers ────────────────────────────────────────────────────────────────

die()  { printf '%s\n' "$*" >&2; exit 1; }
die2() { printf '%s\n' "$*" >&2; exit 2; }

usage() {
    printf 'Usage: bash install.sh [OPTIONS]\n\n'
    printf 'Options:\n'
    printf '  --dry-run              Print plan, change nothing\n'
    printf '  --yes                  Skip confirmation prompt\n'
    printf '  --credentials <folder> Remember the credentials folder\n'
    printf '  --knowledge <folder>   Remember the SecondBrain knowledge base\n'
    printf '  --uninstall            Remove installed files (reads the receipt)\n'
    printf '  --home <dir>           Target home directory (default: $HOME)\n'
    printf '  --self-test            Run referee and setup self-tests (no tokens)\n'
    printf '  --allow-downgrade      Install even when packet is older than installed\n'
    printf '  --unavailable <ids>    Comma-separated model ids to mark unavailable\n'
    printf '  --clear-unavailable    Empty the saved unavailable list first\n'
    printf '  --help                 Show this help\n'
}

# SHA-256 hash of a file → 64 lowercase hex chars
if command -v shasum >/dev/null 2>&1; then
    hash_file() { shasum -a 256 "$1" 2>/dev/null | cut -c1-64; }
    hash_stdin() { shasum -a 256 2>/dev/null | cut -c1-64; }
elif command -v sha256sum >/dev/null 2>&1; then
    hash_file() { sha256sum "$1" 2>/dev/null | cut -c1-64; }
    hash_stdin() { sha256sum 2>/dev/null | cut -c1-64; }
else
    die 'No SHA-256 tool found (tried shasum and sha256sum).'
fi

# Control characters are dropped (not valid inside a JSON string); backslash and quote escaped.
json_escape() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
sed_esc()     { printf '%s' "$1" | sed 's/[&\\|]/\\&/g'; }

# Run tool --version with 8-second limit; prints raw output
version_of() {
    local tool="$1"
    if command -v timeout >/dev/null 2>&1; then
        timeout 8 "$tool" --version 2>/dev/null || true
    else
        local tmpf pid watcher
        tmpf=$(mktemp)
        "$tool" --version >"$tmpf" 2>/dev/null &
        pid=$!
        ( sleep 8; kill "$pid" 2>/dev/null ) &
        watcher=$!
        wait "$pid" 2>/dev/null || true
        kill "$watcher" 2>/dev/null || true
        wait "$watcher" 2>/dev/null || true
        cat "$tmpf"
        rm -f "$tmpf"
    fi
}

# version_ge A B → 0 if A >= B (leading v stripped, x.y.z)
version_ge() {
    local a="${1#v}" b="${2#v}"
    local a1 a2 a3 b1 b2 b3
    a1=$(printf '%s' "$a" | cut -d. -f1); a1="${a1:-0}"
    a2=$(printf '%s' "$a" | cut -d. -f2); a2="${a2:-0}"
    a3=$(printf '%s' "$a" | cut -d. -f3); a3="${a3:-0}"
    b1=$(printf '%s' "$b" | cut -d. -f1); b1="${b1:-0}"
    b2=$(printf '%s' "$b" | cut -d. -f2); b2="${b2:-0}"
    b3=$(printf '%s' "$b" | cut -d. -f3); b3="${b3:-0}"
    if   [ "$a1" -gt "$b1" ]; then return 0
    elif [ "$a1" -lt "$b1" ]; then return 1
    elif [ "$a2" -gt "$b2" ]; then return 0
    elif [ "$a2" -lt "$b2" ]; then return 1
    elif [ "$a3" -ge "$b3" ]; then return 0
    else return 1; fi
}

# pkt_ge A B → 0 if A >= B  (packet version YYYY.MM.DD[-N])
pkt_ge() {
    local a="$1" b="$2"
    local a_date a_n b_date b_n
    a_date="${a%%-*}"; if [ "$a" != "$a_date" ]; then a_n="${a##*-}"; else a_n=0; fi
    b_date="${b%%-*}"; if [ "$b" != "$b_date" ]; then b_n="${b##*-}"; else b_n=0; fi
    local a_num b_num
    a_num=$(printf '%s' "$a_date" | tr -d '.')
    b_num=$(printf '%s' "$b_date" | tr -d '.')
    case "$a_num" in *[!0-9]*) return 1 ;; esac
    case "$b_num" in *[!0-9]*) return 1 ;; esac
    case "$a_n"   in *[!0-9]*) a_n=0 ;; esac
    case "$b_n"   in *[!0-9]*) b_n=0 ;; esac
    if   [ "$a_num" -gt "$b_num" ] 2>/dev/null; then return 0
    elif [ "$a_num" -lt "$b_num" ] 2>/dev/null; then return 1
    elif [ "$a_n"  -ge "$b_n"  ] 2>/dev/null; then return 0
    else return 1; fi
}
pkt_eq() { pkt_ge "$1" "$2" && pkt_ge "$2" "$1"; }
pkt_gt() { pkt_ge "$1" "$2" && ! pkt_eq "$1" "$2"; }

# canon_set PATH: sets CANON to PATH with every existing component resolved, following symlinks
# (a symlink in the last component too), so a path that leads out through a link is judged by
# where it really points; components that do not exist yet are kept as written. CANON is empty
# for a link loop. The last folder resolved is remembered, since targets come folder by folder.
CANON=""
_CANON_DIR=""
_CANON_REAL=""
canon_set() {
    local p="$1" suffix="" hops=0 t dir real
    while [ -L "$p" ]; do
        hops=$((hops + 1)); [ "$hops" -gt 32 ] && { CANON=""; return 0; }
        t=$(readlink "$p" 2>/dev/null) || { CANON=""; return 0; }
        case "$t" in /*) p="$t" ;; *) p="${p%/*}/$t" ;; esac
    done
    dir="$p"
    while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
        suffix="/${dir##*/}${suffix}"
        case "$dir" in */*) dir="${dir%/*}" ;; *) dir="." ;; esac
        [ -z "$dir" ] && dir="/"
    done
    if [ "$dir" = "$_CANON_DIR" ]; then
        real="$_CANON_REAL"
    else
        real=$(cd -P "$dir" 2>/dev/null && pwd -P) || real="$dir"
        _CANON_DIR="$dir"; _CANON_REAL="$real"
    fi
    [ "$real" = "/" ] && real=""
    CANON="$real$suffix"
}
canonical_path() { canon_set "$1"; printf '%s' "$CANON"; }

# The owned locations, made canonical the same way (so a home whose .claude folder is itself a
# symlink still matches its own files). Folders end with "/"; single files do not.
OWNED_DIRS=""
OWNED_FILES=""
owned_init() {
    local rel c nl='
'
    OWNED_DIRS=""; OWNED_FILES=""
    for rel in .config/delegate-skills .claude/skills/consensus .claude/skills/codex-delegate \
               .claude/skills/cursor-delegate .claude/skills/muse-delegate \
               .claude/skills/delegate-setup .agents/skills/consensus; do
        c=$(canonical_path "$TARGET_HOME/$rel"); [ -n "$c" ] && OWNED_DIRS="${OWNED_DIRS}${c}/${nl}"
    done
    for rel in .claude/agents/explore.md .claude/agents/implementer.md .claude/agents/researcher.md \
               .claude/agents/verifier.md .claude/agents/haiku-helper.md .claude/CLAUDE.md; do
        c=$(canonical_path "$TARGET_HOME/$rel"); [ -n "$c" ] && OWNED_FILES="${OWNED_FILES}${c}${nl}"
    done
}

# is_owned_inside PATH → 0 if the canonical path lies inside an owned location (owned_init first)
is_owned_inside() {
    local o IFS='
'
    canon_set "$1"
    [ -n "$CANON" ] || return 1
    for o in $OWNED_DIRS; do
        case "$CANON/" in "$o"*) return 0 ;; esac
    done
    for o in $OWNED_FILES; do
        [ "$CANON" = "$o" ] && return 0
    done
    return 1
}

ladder_contained() {
    local p
    for p in "$FRONTDESK_DIR" "$FRONTDESK_RECEIPT" "$TARGET_HOME/.config/delegate-skills/.backups/frontdesk" \
             "$FRONTDESK_DIR/bin" "$FRONTDESK_DIR/bin.prev" "$FRONTDESK_DIR/generations" \
             "$FRONTDESK_DIR/state" "$FRONTDESK_DIR/logs" "$FRONTDESK_DIR/current.json"; do
        is_owned_inside "$p" || return 1
    done
    if [ -d "$FRONTDESK_DIR/generations" ]; then
        for p in "$FRONTDESK_DIR/generations/"* "$FRONTDESK_DIR/generations/".[!.]* "$FRONTDESK_DIR/generations/"..?*; do
            { [ -e "$p" ] || [ -L "$p" ]; } || continue
            is_owned_inside "$p" || return 1
        done
    fi
    return 0
}

# Only our own packet receipt's line format is read without Node. Both writers keep ladder on
# one line, like consensus/lanes; lastInstalled is a flat object and is carried verbatim.
read_packet_ladder() {
    LADDER_OWNED=false; LADDER_LAST_INSTALLED=null
    local line
    line=$(sed -n 's/^[[:space:]]*"ladder"[[:space:]]*:[[:space:]]*//p' "$RECEIPT_FILE" | head -1)
    if printf '%s' "$line" | grep -Eq '^\{[[:space:]]*"owned"[[:space:]]*:[[:space:]]*true[[:space:]]*,'; then
        LADDER_OWNED=true
    fi
    local saved
    saved=$(printf '%s' "$line" | sed -n -E 's/.*"lastInstalled"[[:space:]]*:[[:space:]]*(\{[^}]*\}|null)[[:space:]]*,[[:space:]]*"lastAttempt".*/\1/p')
    [ -n "$saved" ] && LADDER_LAST_INSTALLED="$saved"
    return 0
}

# The front desk receipt is arbitrary JSON, so use Node rather than the packet's line parser.
# A missing/invalid hooks object, arrays and null never establish packet ownership.
read_team_frontdesk_receipt() {
    [ "$RUNTIME_AVAILABLE" = "1" ] || return 1
    "$TOOL_NODE" -e '
      try {
        const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (!r || r.installedBy !== "team-packet" || !r.hooks || typeof r.hooks !== "object" ||
            Array.isArray(r.hooks) || Object.keys(r.hooks).length) process.exit(1);
        console.log(JSON.stringify({release:r.release,generation:r.generation,frontdesk:r.frontdesk}));
      } catch { process.exit(1); }
    ' "$FRONTDESK_RECEIPT" 2>/dev/null
}

ladder_profile_line() {
    local release version
    case "$LADDER_STATUS" in installed|unchanged|pending)
        if [ "$LADDER_LAST_INSTALLED" != null ]; then
            release=$(printf '%s' "$LADDER_LAST_INSTALLED" | sed -n 's/.*"release"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            version=$(printf '%s' "$LADDER_LAST_INSTALLED" | sed -n 's/.*"frontdesk"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            printf -- '- Role ladder: installed (release %s, front desk %s); ask it with node "%s/.config/delegate-skills/frontdesk/bin/role.mjs" plan "<role>"\n' "$release" "$version" "$TARGET_HOME"
            return
        fi ;;
    esac
    printf -- '- Role ladder: not installed (%s)\n' "$LADDER_REASON"
}

initialize_ladder() {
    LADDER_OWNED=false; LADDER_LAST_INSTALLED=null
    [ "$PREV_RECEIPT_OURS" = "1" ] && read_packet_ladder
    LADDER_STATUS=pending; LADDER_REASON='installation pending'
    if [ "$RUNTIME_AVAILABLE" != "1" ]; then
        LADDER_STATUS=skipped; LADDER_REASON='needs Node 18+'
    elif ! ladder_contained; then
        LADDER_STATUS=skipped; LADDER_REASON='a link leads outside the owned folders'
    elif [ -e "$FRONTDESK_DIR" ] || [ -L "$FRONTDESK_DIR" ] || [ -e "$FRONTDESK_RECEIPT" ] || [ -L "$FRONTDESK_RECEIPT" ]; then
        if [ "$LADDER_OWNED" != true ] || \
            { { [ -e "$FRONTDESK_RECEIPT" ] || [ -L "$FRONTDESK_RECEIPT" ]; } && ! read_team_frontdesk_receipt >/dev/null; }; then
            LADDER_STATUS=kept; LADDER_REASON='a front desk installed outside this packet is here; left as it is'
        fi
    fi
    LADDER_TEXT=$(ladder_profile_line)
}

ladder_summary() {
    case "$LADDER_STATUS" in
        skipped) printf 'Ladder: SKIP (%s)\n' "$LADDER_REASON" ;;
        kept) printf 'Ladder: KEEP (%s)\n' "$LADDER_REASON" ;;
        failed) printf 'Ladder: not installed (%s); the previous state is kept\n' "$LADDER_REASON" ;;
        failed-rollback-incomplete) printf 'Ladder: install failed and its rollback is incomplete (%s); see the front desk backups\n' "$LADDER_REASON" ;;
        *) printf 'Ladder: %s (%s)\n' "$LADDER_STATUS" "$LADDER_REASON" ;;
    esac
}

install_ladder() {
    printf '\nLadder\n'
    if [ "$LADDER_STATUS" != pending ]; then ladder_summary | sed 's/^/  /'; return 0; fi
    if ! ladder_contained; then
        LADDER_STATUS=skipped; LADDER_REASON='a link leads outside the owned folders'
        ladder_summary | sed 's/^/  /'; return 0
    fi
    local declared code out err first data
    declared=$(printf '%s\n' "$UNAVAIL_IDS" | sed '/^$/d' | tr '\n' ',' | sed 's/,$//')
    [ -n "$declared" ] || declared=-
    local args=("$SCRIPT_DIR/frontdesk/install-frontdesk.mjs" install --no-hooks --no-live-check
        --installed-by team-packet --exclude-required qwen-local --exclude-declared "$declared"
        --shared-root "$SCRIPT_DIR" --home "$TARGET_HOME")
    [ "$OPT_DRY_RUN" = "1" ] || args+=(--yes)
    out=$(mktemp); err=$(mktemp); code=0
    if [ -n "${TEAM_LADDER_TEST_FAIL:-}" ]; then
        FRONTDESK_TEST_HOOKS=1 FRONTDESK_TEST_FAIL="$TEAM_LADDER_TEST_FAIL" "$TOOL_NODE" "${args[@]}" >"$out" 2>"$err" || code=$?
    else
        "$TOOL_NODE" "${args[@]}" >"$out" 2>"$err" || code=$?
    fi
    sed 's/^/  /' "$out"; sed 's/^/  /' "$err"
    if [ "$code" -ne 0 ]; then
        LADDER_STATUS=failed
        [ "$code" -eq 4 ] && LADDER_STATUS=failed-rollback-incomplete
        first=$(sed -n '/^install-frontdesk:/ {p;q;}' "$err")
        [ -n "$first" ] || first=$(sed -n '/[^[:space:]]/ {p;q;}' "$err")
        [ -n "$first" ] || first=$(sed -n '/[^[:space:]]/ {p;q;}' "$out")
        LADDER_REASON="${first:-front desk exited $code}"
    elif [ "$OPT_DRY_RUN" != "1" ]; then
        if data=$(read_team_frontdesk_receipt); then
            LADDER_STATUS=installed; LADDER_REASON='installed without hooks'
            if grep -q 'already installed, nothing to do' "$out"; then
                LADDER_STATUS=unchanged; LADDER_REASON='already installed, nothing to do'
            fi
            if [ "$LADDER_STATUS" != unchanged ] || [ "$LADDER_LAST_INSTALLED" = null ]; then
                LADDER_LAST_INSTALLED="${data%\}},\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}"
            fi
            LADDER_OWNED=true
        else
            LADDER_STATUS=failed; LADDER_REASON='front desk returned success without a readable team receipt'
        fi
    fi
    rm -f "$out" "$err"
    LADDER_TEXT=$(ladder_profile_line)
}

uninstall_ladder() {
    read_packet_ladder
    if [ "$LADDER_OWNED" != true ]; then
        printf '  Ladder: KEEP (not owned by this packet)\n'
    elif ! ladder_contained; then
        printf '  Ladder: KEEP (a link leads outside the owned folders)\n'
    elif { [ -e "$FRONTDESK_RECEIPT" ] || [ -L "$FRONTDESK_RECEIPT" ]; } && [ "$RUNTIME_AVAILABLE" != "1" ]; then
        printf '  Ladder: KEEP (needs Node 18+ to read the front desk receipt)\n'
    elif { [ -e "$FRONTDESK_RECEIPT" ] || [ -L "$FRONTDESK_RECEIPT" ]; } && ! read_team_frontdesk_receipt >/dev/null; then
        printf '  Ladder: KEEP (front desk receipt is unreadable or belongs to another install, or has hooks)\n'
    else
        # rm without a trailing slash unlinks directory symlinks; recursion never follows links.
        rm -rf -- "$FRONTDESK_DIR"
        rm -f -- "$FRONTDESK_RECEIPT"
        printf '  Ladder: removed packet-owned front desk and receipt\n'
    fi
}

# AGENTS.md has its own byte splice. Its canonical path is deliberately NOT an owned-list entry.
read_packet_codex() {
    CODEX_RECORD_JSON=null; CODEX_PREV_OWNED=0; CODEX_RECORD_PATH=""; CODEX_CREATED=false; CODEX_SEPARATOR_ENC=""
    local line saved
    line=$(sed -n 's/^[[:space:]]*"codexSection"[[:space:]]*:[[:space:]]*//p' "$RECEIPT_FILE" | head -1 | sed 's/,[[:space:]]*$//')
    if printf '%s' "$line" | grep -Eq '^\{[[:space:]]*"owned"[[:space:]]*:[[:space:]]*true[[:space:]]*,' &&
       printf '%s' "$line" | grep -Eq '"created"[[:space:]]*:[[:space:]]*(true|false)([[:space:]]*[,}])' &&
       printf '%s' "$line" | grep -Eq '"separator"[[:space:]]*:[[:space:]]*"[^"]*"'; then
        CODEX_RECORD_PATH=$(printf '%s' "$line" | sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        CODEX_SEPARATOR_ENC=$(printf '%s' "$line" | sed -n 's/.*"separator"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        printf '%s' "$line" | grep -Eq '"created"[[:space:]]*:[[:space:]]*true' && CODEX_CREATED=true
        case "$CODEX_SEPARATOR_ENC" in ''|'\n'|'\n\n'|'\r\n'|'\r\n\r\n')
            if [ -n "$CODEX_RECORD_PATH" ]; then CODEX_RECORD_JSON="$line"; CODEX_PREV_OWNED=1; fi ;;
        esac
    fi
}

codex_skip_reason() {
    local uninstall="${1:-0}" env_path root
    CODEX_CURRENT_REASON=""; CODEX_CANONICAL=$(canonical_path "$CODEX_AGENTS")
    case "$CODEX_CANONICAL" in "$TARGET_HOME/"*) : ;; *) CODEX_CURRENT_REASON='a link leads outside this home'; return ;; esac
    if [ -n "${CODEX_HOME:-}" ]; then
        env_path="$CODEX_HOME"
        case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) env_path=$(cygpath -u "$env_path") ;; esac
        env_path=$(canonical_path "$env_path"); root=$(canonical_path "$TARGET_HOME/.codex")
        if [ "$env_path" != "$root" ]; then CODEX_CURRENT_REASON="CODEX_HOME points to $CODEX_HOME, outside this home: add the section there yourself"; return; fi
    fi
    if [ "$uninstall" != "1" ] && [ -z "$TOOL_CODEX" ]; then CODEX_CURRENT_REASON='needs Codex'; fi
}

codex_scan() {
    local file="$1" size
    size=$(wc -c < "$file" | tr -d ' \r\n')
    # Git Bash's awk otherwise translates CRLF on input. POSIX awk accepts this as an ordinary variable.
    LC_ALL=C awk -v BINMODE=3 -v total="$size" '
      BEGIN { off=0; count=0; start=-1; end=total; eol="LF" }
      { raw=$0; len=length(raw); terminated=(off+len<total); prefix=0;
        if (NR==1 && terminated && substr(raw,len,1)=="\r") eol="CRLF";
        if (terminated) sub(/\r$/,"",raw);
        if (NR==1 && substr(raw,1,3)=="\357\273\277") { raw=substr(raw,4); prefix=3 }
        if(start>=0 && end==total && off+prefix>start && raw ~ /^## /) end=off;
        if(raw ~ /^## Delegation \(shared rulebook\)[ \t]*$/) { count++; if(count==1)start=off+prefix }
        off+=len+terminated;
      }
      END { printf "%d %d %d %d %s\n",count,start,end,total,eol }
    ' "$file"
}

initialize_codex_section() {
    local uninstall="${1:-0}" previous_valid="${2:-0}" owned_here=0 section eol_enc prefix sep_size
    CODEX_RECORD_JSON=null; CODEX_PREV_OWNED=0; CODEX_RECORD_PATH=""; CODEX_CREATED=false; CODEX_SEPARATOR_ENC=""
    [ "$previous_valid" = "1" ] && read_packet_codex
    CODEX_PREVIOUS_JSON="$CODEX_RECORD_JSON"; CODEX_ACTION=SKIP; CODEX_SOURCE_EXISTS=0
    CODEX_ORIGINAL_TMP=""; CODEX_RESULT_TMP=""
    codex_skip_reason "$uninstall"; CODEX_REASON="$CODEX_CURRENT_REASON"
    if [ -n "$CODEX_REASON" ]; then
        if [ "$uninstall" != "1" ] && [ "$CODEX_REASON" = 'needs Codex' ] && [ "$CODEX_PREV_OWNED" = "1" ]; then CODEX_ACTION=KEEP; CODEX_REASON='Codex not found; left as installed'; fi
        return
    fi
    [ "$CODEX_PREV_OWNED" = "1" ] && [ "$CODEX_RECORD_PATH" = "$CODEX_CANONICAL" ] && owned_here=1
    if [ "$uninstall" = "1" ] && [ "$owned_here" != "1" ]; then CODEX_ACTION=KEEP; CODEX_REASON='Codex section not owned at this canonical path'; return; fi
    CODEX_ORIGINAL_TMP=$(mktemp); CODEX_RESULT_TMP=$(mktemp)
    if [ -e "$CODEX_AGENTS" ] || [ -L "$CODEX_AGENTS" ]; then
        [ -f "$CODEX_AGENTS" ] && cp "$CODEX_AGENTS" "$CODEX_ORIGINAL_TMP" || die2 "could not read $CODEX_AGENTS; no changes made"
        CODEX_SOURCE_EXISTS=1
    fi
    read -r CODEX_COUNT CODEX_START CODEX_END CODEX_SIZE CODEX_EOL <<< "$(codex_scan "$CODEX_ORIGINAL_TMP")"
    [ "$CODEX_COUNT" -le 1 ] || die2 'AGENTS.md has more than one "## Delegation (shared rulebook)" section; no changes made'
    if [ "$uninstall" = "1" ]; then
        prefix="$CODEX_START"
        if [ "$CODEX_START" -lt 0 ]; then cp "$CODEX_ORIGINAL_TMP" "$CODEX_RESULT_TMP"
        else
            if [ "$CODEX_END" -eq "$CODEX_SIZE" ] && [ -n "$CODEX_SEPARATOR_ENC" ]; then
                local sep_file tail_file
                sep_file=$(mktemp); tail_file=$(mktemp); printf '%b' "$CODEX_SEPARATOR_ENC" > "$sep_file"
                sep_size=$(wc -c < "$sep_file" | tr -d ' \r\n')
                if [ "$prefix" -ge "$sep_size" ]; then
                    dd if="$CODEX_ORIGINAL_TMP" bs=1 skip=$((prefix-sep_size)) count="$sep_size" 2>/dev/null > "$tail_file"
                    cmp -s "$sep_file" "$tail_file" && prefix=$((prefix-sep_size))
                fi
                rm -f "$sep_file" "$tail_file"
            fi
            { dd if="$CODEX_ORIGINAL_TMP" bs=1 count="$prefix" 2>/dev/null
              dd if="$CODEX_ORIGINAL_TMP" bs=1 skip="$CODEX_END" count=$((CODEX_SIZE-CODEX_END)) 2>/dev/null; } > "$CODEX_RESULT_TMP"
        fi
        CODEX_ACTION=REMOVE; return
    fi
    if [ "$CODEX_COUNT" = "1" ] && [ "$owned_here" != "1" ]; then CODEX_ACTION=KEEP; CODEX_REASON='a "Delegation (shared rulebook)" section the packet did not write is here; left as it is'; return; fi
    section=$(mktemp)
    local folders_section_file
    folders_section_file=$(mktemp); printf '%s\n' "$FOLDERS_SECTION" > "$folders_section_file"
    sed -e "s|{{SHARED_ROOT}}|$(sed_esc "$POLICY_DIR")|g" -e 's|{{PROFILE}}|team|g' "$SCRIPT_DIR/codex/AGENTS-bootstrap.md" | tr -d '\r' | \
        awk -v ff="$folders_section_file" '/\{\{FOLDERS\}\}/ { while ((getline ln < ff)>0) a[++n]=ln; close(ff); next } { a[++n]=$0 } END { last=n; while(last>0 && a[last]=="")last--; for(i=1;i<=last;i++)print a[i] }' > "$section"
    rm -f "$folders_section_file"
    [ "$(grep -c '^## ' "$section")" = "1" ] && ! grep -q '{{' "$section" || die2 'invalid Codex bootstrap template'
    eol_enc='\n'; [ "$CODEX_EOL" = CRLF ] && eol_enc='\r\n'
    if [ "$CODEX_EOL" = CRLF ]; then local converted; converted=$(mktemp); LC_ALL=C awk -v BINMODE=3 '{printf "%s\r\n",$0}' "$section" > "$converted"; mv "$converted" "$section"; fi
    if [ "$CODEX_START" -ge 0 ] && [ "$CODEX_END" -lt "$CODEX_SIZE" ]; then printf '%b' "$eol_enc" >> "$section"; fi
    if [ "$CODEX_START" -lt 0 ]; then
        CODEX_SEPARATOR_ENC=""
        if [ "$CODEX_SIZE" -gt 0 ]; then
            local last_byte
            last_byte=$(tail -c 1 "$CODEX_ORIGINAL_TMP" | od -An -tu1 | tr -d ' \r\n')
            if [ "$last_byte" = 10 ]; then CODEX_SEPARATOR_ENC="$eol_enc"; else CODEX_SEPARATOR_ENC="${eol_enc}${eol_enc}"; fi
        fi
        CODEX_CREATED=false; [ "$CODEX_SOURCE_EXISTS" = "0" ] && CODEX_CREATED=true
        CODEX_RECORD_PATH="$CODEX_CANONICAL"
        CODEX_RECORD_JSON=$(printf '{"owned":true,"path":"%s","created":%s,"separator":"%s"}' "$(json_escape "$CODEX_RECORD_PATH")" "$CODEX_CREATED" "$CODEX_SEPARATOR_ENC")
        { cat "$CODEX_ORIGINAL_TMP"; printf '%b' "$CODEX_SEPARATOR_ENC"; cat "$section"; } > "$CODEX_RESULT_TMP"
    else
        { dd if="$CODEX_ORIGINAL_TMP" bs=1 count="$CODEX_START" 2>/dev/null; cat "$section"
          dd if="$CODEX_ORIGINAL_TMP" bs=1 skip="$CODEX_END" count=$((CODEX_SIZE-CODEX_END)) 2>/dev/null; } > "$CODEX_RESULT_TMP"
    fi
    rm -f "$section"
    CODEX_ACTION=CREATE
    if [ "$CODEX_SOURCE_EXISTS" = "1" ]; then if cmp -s "$CODEX_ORIGINAL_TMP" "$CODEX_RESULT_TMP"; then CODEX_ACTION=UNCHANGED; else CODEX_ACTION=UPDATE; fi; fi
}

write_codex_section() {
    local uninstall="${1:-0}" exists_now=0
    case "$CODEX_ACTION" in CREATE|UPDATE|REMOVE) : ;; *) return ;; esac
    codex_skip_reason "$uninstall"
    if [ -n "$CODEX_CURRENT_REASON" ] || [ "$CODEX_RECORD_PATH" != "$CODEX_CANONICAL" ]; then
        printf 'SKIP (%s) %s (delegation section)\n' "$CODEX_CURRENT_REASON" "$CODEX_AGENTS"; CODEX_RECORD_JSON="$CODEX_PREVIOUS_JSON"; CODEX_ACTION=SKIP; CODEX_REASON="$CODEX_CURRENT_REASON"; return
    fi
    [ -e "$CODEX_AGENTS" ] && exists_now=1
    if [ "$exists_now" != "$CODEX_SOURCE_EXISTS" ] || { [ "$exists_now" = "1" ] && ! cmp -s "$CODEX_ORIGINAL_TMP" "$CODEX_AGENTS"; }; then
        printf 'KEEP (changed since planning) %s\n' "$CODEX_AGENTS"; CODEX_RECORD_JSON="$CODEX_PREVIOUS_JSON"; CODEX_ACTION=KEEP; CODEX_REASON='changed since planning'; return
    fi
    if [ "$uninstall" = "1" ] && [ "$CODEX_CREATED" = true ] && [ ! -s "$CODEX_RESULT_TMP" ]; then rm -f "$CODEX_AGENTS"
    elif [ "$exists_now" = "1" ] || [ "$uninstall" != "1" ]; then
        mkdir -p "$(dirname "$CODEX_AGENTS")" || die 'cannot create Codex instructions folder'
        cp "$CODEX_RESULT_TMP" "$CODEX_AGENTS" || die 'cannot write Codex section'
        cmp -s "$CODEX_RESULT_TMP" "$CODEX_AGENTS" || die 'Codex section post-write hash mismatch'
    fi
}

entry_text() {
    local entries=""
    if [ -z "$TOOL_CLAUDE" ] && [ -z "$TOOL_CODEX" ]; then
        printf 'No instructions file written: tell your agent to read %s/POLICY.md before nontrivial work (Muse also finds the consensus skill).\n' "$POLICY_DIR"; return
    fi
    [ -n "$TOOL_CLAUDE" ] && entries='Claude Code (CLAUDE.md section)'
    case "$CODEX_ACTION" in CREATE|UPDATE|UNCHANGED) [ -n "$entries" ] && entries="$entries, "; entries="${entries}Codex (AGENTS.md section)" ;; esac
    if [ -n "$entries" ]; then printf -- '- Rulebook entry: %s\n' "$entries"; else printf -- '- Rulebook entry: not written (%s)\n' "$CODEX_REASON"; fi
}

# parse_settings FILE → print ids one per line; return 0=ok 1=unparseable
# The whole document must be exactly {"unavailable":[ids]} (whitespace allowed between tokens,
# none inside a string); anything else is unreadable, so no exclusion is ever lost silently.
# install.ps1 applies the same rule.
parse_settings() {
    local file="$1" raw compact inner
    [ -f "$file" ] || return 1
    raw=$(cat "$file" 2>/dev/null) || return 1
    raw="${raw#$'\xEF\xBB\xBF'}"
    # Every string on one line and free of whitespace (fields 2, 4, ... lie inside quotes).
    printf '%s\n' "$raw" | awk -F'"' '{ if (NF % 2 == 0) bad = 1; for (i = 2; i <= NF; i += 2) if ($i ~ /[[:space:]]/) bad = 1 } END { exit bad }' || return 1
    compact=$(printf '%s' "$raw" | tr -d ' \t\r\n')
    printf '%s\n' "$compact" | grep -Eq '^\{"unavailable":\[("[A-Za-z0-9._-]+"(,"[A-Za-z0-9._-]+")*)?\]\}$' || return 1
    inner="${compact#\{\"unavailable\":\[}"
    inner="${inner%\]\}}"
    [ -z "$inner" ] && return 0
    printf '%s\n' "$inner" | tr ',' '\n' | tr -d '"'
    return 0
}

# backup_file FILE → copy to BACKUP_DIR, verify hash; return 1 on failure
# BACKUP_DIR must exist before calling
backup_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    local rel bname orig_h bak_h
    rel="${file#${TARGET_HOME}/}"
    bname=$(printf '%s' "$rel" | sed 's|/|-|g')
    cp "$file" "$BACKUP_DIR/$bname" 2>/dev/null || return 1
    orig_h=$(hash_file "$file")
    bak_h=$(hash_file "$BACKUP_DIR/$bname")
    [ "$orig_h" = "$bak_h" ] || return 1
    return 0
}

# file_status DST EXPECTED_HASH → prints CREATE/UPDATE/UNCHANGED
file_status() {
    local dst="$1" expected="$2"
    if [ ! -f "$dst" ]; then printf 'CREATE'; return; fi
    local dh
    dh=$(hash_file "$dst")
    if [ "$dh" = "$expected" ]; then printf 'UNCHANGED'; else printf 'UPDATE'; fi
}

# profile_norm: neutralise date line for stable comparison
profile_norm() { sed -E 's/^Rendered by the delegation team packet installer on .*/Rendered by the delegation team packet installer on DATE/; /^- Repositories:/s/, set with --repos\)$/)/; s/` \((found|set with --credentials|set with --knowledge|chosen by you|kept from the last run)\)$/` (remembered)/'; }

# splice_claude_md FILE SECTION_FILE MODE  (install|uninstall)
splice_claude_md() {
    local file="$1" secfile="$2" mode="$3"
    if [ ! -f "$file" ]; then
        [ "$mode" = "uninstall" ] && return 0
        cat "$secfile" > "$file"; printf '\n' >> "$file"; return 0
    fi
    local count
    count=$(grep -c '^## Delegation (shared rulebook)[[:space:]]*$' "$file" 2>/dev/null) || count=0
    if [ "$count" -gt 1 ]; then
        printf 'CLAUDE.md has more than one "## Delegation (shared rulebook)" section; cannot splice\n' >&2
        exit 2
    fi
    local tmp
    tmp=$(mktemp)
    if [ "$count" -eq 0 ]; then
        [ "$mode" = "uninstall" ] && return 0
        cat "$file" > "$tmp"; printf '\n' >> "$tmp"
        cat "$secfile" >> "$tmp"; printf '\n' >> "$tmp"
        mv "$tmp" "$file"; return 0
    fi
    awk -v secfile="$secfile" -v mode="$mode" '
    BEGIN { in_sec = 0 }
    /^## Delegation \(shared rulebook\)[[:space:]]*$/ {
        in_sec = 1
        if (mode == "install") {
            while ((getline ln < secfile) > 0) print ln
            close(secfile); print ""
        }
        next
    }
    in_sec && /^## / { in_sec = 0; print; next }
    in_sec { next }
    { print }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
}

# render_template SRC DST CONVERT_BACKSLASH(0|1)
# All global render vars (ROUTES_TEXT, LANES_TEXT, CONSENSUS_TEXT, etc.) must be set.
render_template() {
    local src="$1" dst="$2" conv="${3:-0}"
    local tmp routes_f lanes_f consensus_f t2
    tmp=$(mktemp); routes_f=$(mktemp); lanes_f=$(mktemp); consensus_f=$(mktemp)
    local folders_f
    folders_f=$(mktemp)
    if [ "$conv" = 1 ]; then printf '%s\n' "$FOLDERS_SECTION" > "$folders_f"
    else printf '%s\n' "$FOLDERS_TEXT" > "$folders_f"; fi
    local repos_f tools_f
    repos_f=$(mktemp); tools_f=$(mktemp)
    printf '%s\n' "$ROUTES_TEXT"    > "$routes_f"
    printf '%s\n' "$LANES_TEXT"     > "$lanes_f"
    printf '%s\n' "$CONSENSUS_TEXT" > "$consensus_f"
    printf '%s\n' "$REPOS_TEXT"     > "$repos_f"
    printf '%s\n' "$TOOLS_TEXT"     > "$tools_f"
    local e_shared e_referee e_ledger e_home e_pkt e_date e_os
    local e_claude e_node e_codex e_cursor e_muse e_ladder e_entry
    e_entry=$(sed_esc "$ENTRY_TEXT")
    e_ladder=$(sed_esc "$LADDER_TEXT")
    e_shared=$(sed_esc "$POLICY_DIR"); e_referee=$(sed_esc "$REFEREE_PATH")
    e_ledger=$(sed_esc "$LEDGER_DIR"); e_home=$(sed_esc "$TARGET_HOME")
    e_pkt=$(sed_esc "$PACKET_VERSION"); e_date=$(sed_esc "$INSTALL_DATE")
    e_os=$(sed_esc "$OS_NAME"); e_claude=$(sed_esc "$CLAUDE_VER_DISPLAY")
    e_node=$(sed_esc "$NODE_VER_DISPLAY"); e_codex=$(sed_esc "$CODEX_VER_DISPLAY")
    e_cursor=$(sed_esc "$CURSOR_VER_DISPLAY"); e_muse=$(sed_esc "$MUSE_VER_DISPLAY")
    sed \
        -e "s|{{SHARED_ROOT}}|${e_shared}|g" \
        -e "s|{{PROFILE}}|team|g" \
        -e "s|{{REFEREE}}|${e_referee}|g" \
        -e "s|{{LEDGER}}|${e_ledger}|g" \
        -e "s|{{DATE}}|${e_date}|g" \
        -e "s|{{OS}}|${e_os}|g" \
        -e "s|{{HOME}}|${e_home}|g" \
        -e "s|{{PACKET_VERSION}}|${e_pkt}|g" \
        -e "s|{{CLAUDE_VERSION}}|${e_claude}|g" \
        -e "s|{{NODE_VERSION}}|${e_node}|g" \
        -e "s|{{CODEX_VERSION}}|${e_codex}|g" \
        -e "s|{{CURSOR_VERSION}}|${e_cursor}|g" \
        -e "s|{{MUSE_VERSION}}|${e_muse}|g" \
        -e "s|{{RUNTIME}}|${e_referee}|g" \
        -e "s|{{LADDER}}|${e_ladder}|g" \
        -e "s|{{ENTRY}}|${e_entry}|g" \
        "$src" > "$tmp"
    t2=$(mktemp)
    awk -v rf="$routes_f" \
        '/\{\{ROUTES\}\}/ { while ((getline ln < rf) > 0) print ln; close(rf); next } { print }' \
        "$tmp" > "$t2" && mv "$t2" "$tmp"
    t2=$(mktemp)
    awk -v lf="$lanes_f" \
        '/\{\{LANES\}\}/ { while ((getline ln < lf) > 0) print ln; close(lf); next } { print }' \
        "$tmp" > "$t2" && mv "$t2" "$tmp"
    t2=$(mktemp)
    awk -v cf="$consensus_f" \
        '/\{\{CONSENSUS\}\}/ { while ((getline ln < cf) > 0) print ln; close(cf); next } { print }' \
        "$tmp" > "$t2" && mv "$t2" "$tmp"
    t2=$(mktemp)
    awk -v ff="$folders_f" -v rf="$repos_f" -v tf="$tools_f" \
        '/\{\{FOLDERS\}\}/ { while ((getline ln < ff) > 0) print ln; close(ff); next }
         /\{\{REPOS\}\}/ { while ((getline ln < rf) > 0) print ln; close(rf); next }
         /\{\{OTHER_TOOLS\}\}/ { while ((getline ln < tf) > 0) print ln; close(tf); next } { print }' \
        "$tmp" > "$t2" && mv "$t2" "$tmp"
    if [ "$conv" = "1" ]; then
        t2=$(mktemp); tr '\\' '/' < "$tmp" > "$t2" && mv "$t2" "$tmp"
    fi
    t2=$(mktemp); tr -d '\r' < "$tmp" > "$t2" && mv "$t2" "$tmp"
    if grep -q '{{' "$tmp" 2>/dev/null; then
        printf 'ERROR: unrendered placeholder in rendered output (source: %s)\n' "$src" >&2
        rm -f "$tmp" "$routes_f" "$lanes_f" "$consensus_f"; exit 1
    fi
    rm -f "$folders_f"
    mv "$tmp" "$dst"
    rm -f "$routes_f" "$lanes_f" "$consensus_f" "$repos_f" "$tools_f"
}

render_claude_bootstrap() {
    render_template "$SCRIPT_DIR/claude/CLAUDE-bootstrap.md" "$1" 1
}

# ─── option parsing ──────────────────────────────────────────────────────────

OPT_DRY_RUN=0
OPT_YES=0
OPT_UNINSTALL=0
OPT_HOME=""
OPT_SELF_TEST=0
OPT_ALLOW_DOWNGRADE=0
OPT_UNAVAILABLE=""
OPT_CLEAR_UNAVAILABLE=0
OPT_REPOS=""
OPT_CREDENTIALS=""
OPT_KNOWLEDGE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)           OPT_DRY_RUN=1 ;;
        --yes)               OPT_YES=1 ;;
        --uninstall)         OPT_UNINSTALL=1 ;;
        --home)              shift; OPT_HOME="${1:-}" ;;
        --home=*)            OPT_HOME="${1#--home=}" ;;
        --self-test)         OPT_SELF_TEST=1 ;;
        --allow-downgrade)   OPT_ALLOW_DOWNGRADE=1 ;;
        --unavailable)       shift; OPT_UNAVAILABLE="${1:-}" ;;
        --unavailable=*)     OPT_UNAVAILABLE="${1#--unavailable=}" ;;
        --repos)             shift; OPT_REPOS="${1:-}" ;;
        --repos=*)           OPT_REPOS="${1#--repos=}" ;;
        --credentials)       shift; OPT_CREDENTIALS="${1:-}" ;;
        --credentials=*)     OPT_CREDENTIALS="${1#--credentials=}" ;;
        --knowledge)         shift; OPT_KNOWLEDGE="${1:-}" ;;
        --knowledge=*)       OPT_KNOWLEDGE="${1#--knowledge=}" ;;
        --clear-unavailable) OPT_CLEAR_UNAVAILABLE=1 ;;
        --help|-h)           usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
    shift
done

# ─── canonical home ──────────────────────────────────────────────────────────

_home_raw="${OPT_HOME:-${HOME:-}}"
[ -z "$_home_raw" ] && die2 'Cannot determine home directory; use --home <dir>'
TARGET_HOME=$(canonical_path "$_home_raw")
[ -z "$TARGET_HOME" ] && die2 "Cannot resolve the home directory $_home_raw (a symlink loop?)"
owned_init

# ─── step 1: verify packet ───────────────────────────────────────────────────

CHECKSUMS_FILE="$SCRIPT_DIR/CHECKSUMS.txt"
[ -f "$CHECKSUMS_FILE" ] || die2 'packet damaged or incomplete; download it again'

printf 'Verifying packet...\n'
while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    expected=$(printf '%s' "$line" | cut -c1-64)
    relpath=$(printf '%s' "$line" | cut -c67-)
    [ -z "$relpath" ] && continue
    fullpath="$SCRIPT_DIR/$relpath"
    [ -f "$fullpath" ] || die2 "packet damaged or incomplete; download it again (missing: $relpath)"
    actual=$(hash_file "$fullpath")
    [ "$actual" = "$expected" ] || die2 "packet damaged or incomplete; download it again (hash mismatch: $relpath)"
done < "$CHECKSUMS_FILE"
printf 'Packet OK.\n'

PACKET_VERSION="$(tr -d '\r\n' < "$SCRIPT_DIR/VERSION" 2>/dev/null || printf 'unknown')"

# ─── path constants ──────────────────────────────────────────────────────────

POLICY_DIR="$TARGET_HOME/.config/delegate-skills/team-policy"
AGENTS_DIR="$TARGET_HOME/.claude/agents"
CLAUDE_MD="$TARGET_HOME/.claude/CLAUDE.md"
CODEX_AGENTS="$TARGET_HOME/.codex/AGENTS.md"
RUNTIME_DIR="$TARGET_HOME/.config/delegate-skills/consensus"
LOCAL_JSON="$RUNTIME_DIR/local.json"
LEDGER_DIR="$TARGET_HOME/.config/delegate-skills/consensus-ledger"
SKILLS_CLAUDE="$TARGET_HOME/.claude/skills"
SKILLS_AGENTS="$TARGET_HOME/.agents/skills"
LANES_FILE="$TARGET_HOME/.config/delegate-skills/config.json"
SETTINGS_FILE="$TARGET_HOME/.config/delegate-skills/team-settings.json"
RECEIPT_FILE="$TARGET_HOME/.config/delegate-skills/team-install.json"
FRONTDESK_DIR="$TARGET_HOME/.config/delegate-skills/frontdesk"
FRONTDESK_RECEIPT="$TARGET_HOME/.config/delegate-skills/frontdesk-install.json"
BACKUP_BASE="$TARGET_HOME/.config/delegate-skills/.backups/team"
REFEREE_PATH="$RUNTIME_DIR/referee.mjs"

# ─── step 2: detect tools ────────────────────────────────────────────────────

for _envk in ANTHROPIC_API_KEY OPENAI_API_KEY CURSOR_API_KEY XAI_API_KEY MUSE_API_KEY; do
    _envv=""; eval "_envv=\"\${${_envk}:-}\""
    [ -n "$_envv" ] && printf 'WARNING: environment variable %s is set (API keys are banned; installer will continue)\n' "$_envk"
done

# Muse's contributor tier (Meta may use what it is sent to train its models) is banned for team work. Say so when this
# machine's own Muse setting is on (read only; never changed). The file is joined into one line first, so a value on
# the line after its key is found too. The summary says again whether the Muse relay installed here really forces it
# off for its jobs: a relay kept from before or installed by the person may not.
# Muse reads XDG_CONFIG_HOME when it is set (the Muse relay does the same); that applies to this user's own home only.
_muse_cfg="$TARGET_HOME/.config"
if [ -n "${XDG_CONFIG_HOME:-}" ] && [ -n "${HOME:-}" ]; then
    _own_home="$(cd "$HOME" 2>/dev/null && pwd -P || true)"
    _tgt_home="$(cd "$TARGET_HOME" 2>/dev/null && pwd -P || true)"
    if [ -n "$_own_home" ] && [ "$_own_home" = "$_tgt_home" ]; then _muse_cfg="$XDG_CONFIG_HOME"; fi
fi
_muse_settings="$_muse_cfg/muse/settings.json"
MUSE_CONTRIBUTOR_ON=0
if [ -f "$_muse_settings" ] && tr -d '\r\n' < "$_muse_settings" 2>/dev/null | grep -Eq '"contributor_mode_enabled"[[:space:]]*:[[:space:]]*true'; then
    MUSE_CONTRIBUTOR_ON=1
    printf 'WARNING: Muse contributor mode is ON in %s: Meta may use what Muse is sent to train its models, which is banned for team work. Switch it off in Muse (set "contributor_mode_enabled": false).\n' "$_muse_settings"
fi

TOOL_CLAUDE="$(command -v claude 2>/dev/null || true)"
TOOL_NODE="$(command -v node 2>/dev/null || true)"
TOOL_CODEX="$(command -v codex 2>/dev/null || true)"
TOOL_CURSOR="$(command -v cursor-agent 2>/dev/null || true)"
TOOL_MUSE="$(command -v muse 2>/dev/null || true)"

if [ "$OPT_UNINSTALL" != "1" ] && [ "$OPT_SELF_TEST" != "1" ] &&
   [ -z "$TOOL_CLAUDE$TOOL_CODEX$TOOL_CURSOR$TOOL_MUSE" ]; then
    die2 'No supported agent tool found (Claude Code, Codex, Cursor Agent or Muse). Install one, log in, then run the installer again.'
fi

_extract_ver() { grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' | head -1; }

# The machine check runs in Node. Under Git Bash on Windows that is Windows Node, which cannot start
# a POSIX path or a shell script, so it gets the tool's .cmd or .exe sibling in Windows form.
tool_for_node() {
    local p="$1" ext
    [ -n "$p" ] || return 0
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*)
            for ext in .cmd .exe .bat; do
                if [ -f "$p$ext" ]; then p="$p$ext"; break; fi
            done
            command -v cygpath >/dev/null 2>&1 && p=$(cygpath -w "$p")
            ;;
    esac
    printf '%s' "$p"
}

CLAUDE_VER=""
if [ -n "$TOOL_CLAUDE" ]; then
    CLAUDE_VER="$(version_of "$TOOL_CLAUDE" | _extract_ver)"
    [ -z "$CLAUDE_VER" ] && CLAUDE_VER="found (version unknown)"
fi

NODE_VER=""; NODE_MAJOR=0
if [ -n "$TOOL_NODE" ]; then
    NODE_VER="$(version_of "$TOOL_NODE" | _extract_ver)"
    [ -z "$NODE_VER" ] && NODE_VER="found (version unknown)"
    printf '%s' "$NODE_VER" | grep -q '^[0-9]' && NODE_MAJOR=$(printf '%s' "$NODE_VER" | cut -d. -f1)
fi

CODEX_VER=""
if [ -n "$TOOL_CODEX" ]; then
    CODEX_VER="$(version_of "$TOOL_CODEX" | _extract_ver)"
    [ -z "$CODEX_VER" ] && CODEX_VER="found (version unknown)"
fi

CURSOR_VER=""
if [ -n "$TOOL_CURSOR" ]; then
    CURSOR_VER="$(version_of "$TOOL_CURSOR" | _extract_ver)"
    [ -z "$CURSOR_VER" ] && CURSOR_VER="found (version unknown)"
fi

MUSE_VER=""
if [ -n "$TOOL_MUSE" ]; then
    MUSE_VER="$(version_of "$TOOL_MUSE" | _extract_ver)"
    [ -z "$MUSE_VER" ] && MUSE_VER="found (version unknown)"
fi

CLAUDE_VER_DISPLAY="${CLAUDE_VER:-not found}"
NODE_VER_DISPLAY="${NODE_VER:-not installed}"
CODEX_VER_DISPLAY="${CODEX_VER:-not installed}"
CURSOR_VER_DISPLAY="${CURSOR_VER:-not installed}"
MUSE_VER_DISPLAY="${MUSE_VER:-not installed}"

RUNTIME_AVAILABLE=0
[ -n "$TOOL_NODE" ] && [ "$NODE_MAJOR" -ge 18 ] && RUNTIME_AVAILABLE=1

RELAY_CODEX=0;  [ -n "$TOOL_CODEX"  ] && RELAY_CODEX=1
RELAY_CURSOR=0; [ -n "$TOOL_CURSOR" ] && RELAY_CURSOR=1
RELAY_MUSE=0;   [ -n "$TOOL_MUSE"   ] && RELAY_MUSE=1
RELAY_COUNT=$((RELAY_CODEX + RELAY_CURSOR + RELAY_MUSE))

# ─── self-test ───────────────────────────────────────────────────────────────

if [ "$OPT_SELF_TEST" = "1" ]; then
    if [ -z "$TOOL_NODE" ] || [ "$NODE_MAJOR" -lt 18 ]; then
        printf 'Self-test: Node 18+ is not available; cannot run tests.\n'
        exit 0
    fi
    _st_failed=""
    _st_ledger=$(mktemp -d)
    printf '=== Consensus self-test ===\n'
    _consensus_out=$(mktemp)
    _consensus_exit=0
    ( cd "$SCRIPT_DIR/consensus" && CONSENSUS_LEDGER="$_st_ledger" node --test 2>&1 ) > "$_consensus_out" || _consensus_exit=$?
    grep -E '^[^[:alnum:]]*(tests|pass|fail) [0-9]+[[:space:]]*$' "$_consensus_out" | sed 's/^[^[:alnum:]]*/  /' || true
    rm -f "$_consensus_out"
    rm -rf "$_st_ledger"
    [ "$_consensus_exit" -ne 0 ] && _st_failed="${_st_failed} consensus"
    printf '=== Setup self-test ===\n'
    _setup_out=$(mktemp)
    _setup_exit=0
    ( cd "$SCRIPT_DIR/setup" && node --test 2>&1 ) > "$_setup_out" || _setup_exit=$?
    grep -E '^[^[:alnum:]]*(tests|pass|fail) [0-9]+[[:space:]]*$' "$_setup_out" | sed 's/^[^[:alnum:]]*/  /' || true
    rm -f "$_setup_out"
    [ "$_setup_exit" -ne 0 ] && _st_failed="${_st_failed} setup"
    if [ -f "$REFEREE_PATH" ]; then
        printf '\n=== Doctor (installed runtime) ===\n'
        node "$REFEREE_PATH" doctor --human
    fi
    if [ -n "$_st_failed" ]; then
        printf '\nSelf-test FAILED (suites:%s)\n' "$_st_failed" >&2
        exit 1
    fi
    exit 0
fi

# ─── uninstall ───────────────────────────────────────────────────────────────

if [ "$OPT_UNINSTALL" = "1" ]; then
    [ -f "$RECEIPT_FILE" ] || die2 'nothing to uninstall (receipt not found)'
    # Only a receipt whose home, made canonical, is this home may remove anything.
    _rec_home=$(grep '"home"' "$RECEIPT_FILE" | sed 's/.*"home"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1)
    [ -n "$_rec_home" ] || die2 'the receipt names no home; nothing removed'
    _rec_home_canon=$(canonical_path "$_rec_home")
    if [ "$_rec_home_canon" != "$TARGET_HOME" ]; then
        die2 "the receipt belongs to $_rec_home; nothing removed"
    fi
    initialize_codex_section 1 1
    printf '%s (%s) %s (delegation section)\n' "$CODEX_ACTION" "$CODEX_REASON" "$CODEX_AGENTS"
    printf 'Uninstalling...\n'
    while IFS= read -r _line; do
        [ -z "$_line" ] && continue
        printf '%s' "$_line" | grep -q '"/' || continue
        _p=$(printf '%s' "$_line" | sed 's/.*"\(\/[^"]*\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        _h=$(printf '%s' "$_line" | sed 's/.*"\(\/[^"]*\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/')
        case "$_p" in /*) : ;; *) continue ;; esac
        [ "$_p" = "$CLAUDE_MD" ] && continue   # only its section is removed, below
        [ "$_p" = "$CODEX_AGENTS" ] && continue
        is_owned_inside "$_p" || { printf '  SKIPPED (not in owned folders): %s\n' "$_p"; continue; }
        [ -f "$_p" ] || continue
        _cur=$(hash_file "$_p")
        if [ "$_cur" = "$_h" ]; then
            rm -f "$_p"
            printf '  removed: %s\n' "$_p"
        else
            printf '  SKIPPED (modified): %s\n' "$_p"
        fi
    done < "$RECEIPT_FILE"
    for _d in "$RUNTIME_DIR" "$POLICY_DIR" \
              "$SKILLS_CLAUDE/consensus" "$SKILLS_AGENTS/consensus" \
              "$SKILLS_CLAUDE/codex-delegate" "$SKILLS_CLAUDE/cursor-delegate" \
              "$SKILLS_CLAUDE/muse-delegate" "$SKILLS_CLAUDE/delegate-setup"; do
        [ -d "$_d" ] || continue
        find "$_d" -depth -type d -exec rmdir {} \; 2>/dev/null
        if [ -d "$_d" ]; then
            printf '  kept (not empty): %s\n' "$_d"
        else
            printf '  removed dir: %s\n' "$_d"
        fi
    done
    if [ -f "$CLAUDE_MD" ] && grep -Fq "\"$CLAUDE_MD\":" "$RECEIPT_FILE"; then
        _cnt=$(grep -c '^## Delegation (shared rulebook)[[:space:]]*$' "$CLAUDE_MD" 2>/dev/null) || _cnt=0
        if [ "$_cnt" -gt 1 ]; then
            printf 'WARNING: CLAUDE.md has multiple "## Delegation (shared rulebook)" sections; leaving it untouched\n'
        elif [ "$_cnt" -eq 1 ]; then
            _dsec=$(mktemp)
            splice_claude_md "$CLAUDE_MD" "$_dsec" "uninstall"
            rm -f "$_dsec"
            printf '  removed section from: %s\n' "$CLAUDE_MD"
        fi
    fi
    write_codex_section 1
    [ -n "$CODEX_ORIGINAL_TMP" ] && rm -f "$CODEX_ORIGINAL_TMP" "$CODEX_RESULT_TMP"
    uninstall_ladder
    rm -f "$RECEIPT_FILE"
    printf 'Done. Backups are kept in: %s\n' "$BACKUP_BASE"
    exit 0
fi

# The control files (receipt, settings, backup folder) must not lead outside the owned locations
# through a link: stop before any change if one does.
for _cp in "$RECEIPT_FILE" "$SETTINGS_FILE" "$BACKUP_BASE" "$LEDGER_DIR"; do
    is_owned_inside "$_cp" || die2 "$_cp leads outside the installer's folders through a link; remove that link and run again"
done

# ─── step 3: read previous receipt ───────────────────────────────────────────

PREV_RECEIPT_OURS=0
PREV_PACKET_VERSION=""
PREV_SCHEMA=1
PREV_UNAVAILABLE=""
PREV_CONSENSUS_VAL="null"
PREV_LANES_VAL="null"
PREV_REPOS=""
PREV_BACKUP_DIR_JSON='""'
PREV_FILES_TMP=$(mktemp)

if [ -f "$RECEIPT_FILE" ]; then
    _rec_home=$(grep '"home"' "$RECEIPT_FILE" | sed 's/.*"home"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1)
    PREV_PACKET_VERSION=$(grep '"packetVersion"' "$RECEIPT_FILE" | sed 's/.*"packetVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -1)
    _schema_raw=$(grep '"schema"' "$RECEIPT_FILE" | sed 's/.*"schema"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/' | head -1)
    PREV_SCHEMA="${_schema_raw:-1}"

    if [ -n "$_rec_home" ]; then
        _rec_home_canon=$(canonical_path "$_rec_home")
        if [ "$_rec_home_canon" = "$TARGET_HOME" ]; then
            PREV_RECEIPT_OURS=1
        else
            printf 'the receipt at %s belongs to %s; ignored\n' "$RECEIPT_FILE" "$_rec_home"
        fi
    else
        # Without a home the receipt proves no ownership: no pruning, no recovery from it.
        printf 'the receipt at %s names no home; ignored\n' "$RECEIPT_FILE"
    fi

    if [ "$PREV_RECEIPT_OURS" = "1" ]; then
        _previous_backup=$(sed -n 's/^[[:space:]]*"backupDir"[[:space:]]*:[[:space:]]*//p' "$RECEIPT_FILE" | head -1 | sed 's/,[[:space:]]*$//')
        [ -n "$_previous_backup" ] && PREV_BACKUP_DIR_JSON="$_previous_backup"
        # Parse files list
        while IFS= read -r _line; do
            [ -z "$_line" ] && continue
            printf '%s' "$_line" | grep -q '"/' || continue
            _p=$(printf '%s' "$_line" | sed 's/.*"\(\/[^"]*\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
            _h=$(printf '%s' "$_line" | sed 's/.*"\(\/[^"]*\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/')
            case "$_p" in /*) printf '%s\t%s\n' "$_h" "$_p" >> "$PREV_FILES_TMP" ;; esac
        done < "$RECEIPT_FILE"

        if [ "$PREV_SCHEMA" = "2" ]; then
            # Extract unavailable list
            _unavail_inner=$(grep '"unavailable"' "$RECEIPT_FILE" | \
                sed -n 's/.*"unavailable"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | head -1)
            if [ -n "$_unavail_inner" ]; then
                PREV_UNAVAILABLE=$(printf '%s' "$_unavail_inner" | \
                    grep -o '"[A-Za-z0-9._-][A-Za-z0-9._-]*"' | sed 's/"//g' | tr '\n' ' ')
            fi
            # Extract consensus and lanes values (verbatim, for copy in degraded mode)
            PREV_CONSENSUS_VAL=$(grep '"consensus"' "$RECEIPT_FILE" | \
                sed 's/.*"consensus"[[:space:]]*:[[:space:]]*//; s/,[[:space:]]*$//' | head -1)
            PREV_LANES_VAL=$(grep '"lanes"' "$RECEIPT_FILE" | \
                sed 's/.*"lanes"[[:space:]]*:[[:space:]]*//; s/,[[:space:]]*$//' | head -1)
            [ -z "$PREV_CONSENSUS_VAL" ] && PREV_CONSENSUS_VAL="null"
            [ -z "$PREV_LANES_VAL"     ] && PREV_LANES_VAL="null"
            PREV_REPOS=$(grep '"repos"' "$RECEIPT_FILE" | \
                sed -n -E 's/.*"repos"[[:space:]]*:[[:space:]]*\{"path":"([^"]*)".*/\1/p' | head -1 | sed 's/\\\\/\\/g')
        fi
    fi
fi

# Version downgrade guard
if [ "$PREV_RECEIPT_OURS" = "1" ] && [ -n "$PREV_PACKET_VERSION" ]; then
    case "$PREV_PACKET_VERSION" in [0-9][0-9][0-9][0-9].*)
        if pkt_gt "$PREV_PACKET_VERSION" "$PACKET_VERSION"; then
            [ "$OPT_ALLOW_DOWNGRADE" = "0" ] && \
                die2 "A newer packet ($PREV_PACKET_VERSION) is installed; this one is $PACKET_VERSION. Use the newer packet, or run again with --allow-downgrade."
        fi
        ;;
    esac
fi

# ─── step 4: settings (unavailable models) ───────────────────────────────────

UNAVAIL_IDS=""  # newline-separated, built up and then deduped

if [ -f "$SETTINGS_FILE" ]; then
    _parsed=$(parse_settings "$SETTINGS_FILE") && _parse_ok=0 || _parse_ok=$?
    if [ "$_parse_ok" -ne 0 ]; then
        if [ "$OPT_CLEAR_UNAVAILABLE" = "0" ]; then
            die2 'team-settings.json could not be read; fix or delete it, or run again with --clear-unavailable to reset the list of unavailable models'
        fi
        # --clear-unavailable: ignore bad file
        _parsed=""
    fi
    UNAVAIL_IDS="$_parsed"
elif [ "$PREV_RECEIPT_OURS" = "1" ] && [ "$PREV_SCHEMA" = "2" ] && [ -n "$PREV_UNAVAILABLE" ]; then
    # Recover from previous receipt
    UNAVAIL_IDS=$(printf '%s' "$PREV_UNAVAILABLE" | tr ' ' '\n' | grep -E '^[A-Za-z0-9._-]+$')
    _recovered=$(printf '%s' "$UNAVAIL_IDS" | tr '\n' ',' | sed 's/,$//')
    printf 'Recovered the unavailable models from the previous install: %s\n' "$_recovered"
fi

[ "$OPT_CLEAR_UNAVAILABLE" = "1" ] && UNAVAIL_IDS=""

if [ -n "$OPT_UNAVAILABLE" ]; then
    _new=$(printf '%s' "$OPT_UNAVAILABLE" | tr ',' '\n' | grep -E '^[A-Za-z0-9._-]+$')
    UNAVAIL_IDS=$(printf '%s\n%s' "$UNAVAIL_IDS" "$_new")
fi

# Sort and dedupe
UNAVAIL_IDS=$(printf '%s' "$UNAVAIL_IDS" | grep -E '^[A-Za-z0-9._-]+$' | sort -u)
# Space-separated for display
UNAVAIL_DISPLAY=$(printf '%s' "$UNAVAIL_IDS" | tr '\n' ',' | sed 's/,$//')

# Write settings to a temp file for the machine check
SETTINGS_TMP=$(mktemp)
if [ -n "$UNAVAIL_IDS" ]; then
    _ids_json=$(printf '%s' "$UNAVAIL_IDS" | grep -E '^[A-Za-z0-9._-]+$' | \
        sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')
    printf '{"unavailable":[%s]}\n' "$_ids_json" > "$SETTINGS_TMP"
else
    printf '{"unavailable":[]}\n' > "$SETTINGS_TMP"
fi

# ─── step 5: machine check ───────────────────────────────────────────────────

REPOS_ARG="${OPT_REPOS:-$PREV_REPOS}"


# A folder needs native separators in the receipt; unlike tool_for_node, never try executable siblings.
folder_path() {
    local folder
    folder=$(canonical_path "$1")
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) command -v cygpath >/dev/null 2>&1 && folder=$(cygpath -w "$folder") ;;
    esac
    printf '%s' "$folder"
}

# Folder values are recovered only from a receipt owned by this home. The compact folders
# field is also readable without Node (as with ladder); Node handles arbitrary JSON when present.
FOLDER_DIR=$(mktemp -d)
FOLDER_FILE="$FOLDER_DIR/decided.json"
CREDENTIALS_PATH=""; CREDENTIALS_SOURCE=""; KNOWLEDGE_PATH=""; KNOWLEDGE_SOURCE=""
FOLDER_ADVICE=""
if [ "$PREV_RECEIPT_OURS" = 1 ]; then
    if [ "$RUNTIME_AVAILABLE" = 1 ]; then
        CREDENTIALS_PATH=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.folders?.credentials?.path||"")' "$RECEIPT_FILE")
        KNOWLEDGE_PATH=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.folders?.knowledge?.path||"")' "$RECEIPT_FILE")
    else
        CREDENTIALS_PATH=$(sed -n -E 's/.*"folders"[[:space:]]*:.*"credentials"[[:space:]]*:[[:space:]]*\{[[:space:]]*"path"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' "$RECEIPT_FILE" | sed 's/\\\\/\\/g; s/\\"/"/g')
        KNOWLEDGE_PATH=$(sed -n -E 's/.*"folders"[[:space:]]*:.*"knowledge"[[:space:]]*:[[:space:]]*\{[[:space:]]*"path"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' "$RECEIPT_FILE" | sed 's/\\\\/\\/g; s/\\"/"/g')
    fi
fi
CREDENTIALS_SOURCE=kept; KNOWLEDGE_SOURCE=kept
[ -n "$OPT_CREDENTIALS" ] && { CREDENTIALS_PATH="$OPT_CREDENTIALS"; CREDENTIALS_SOURCE=set; }
[ -n "$OPT_KNOWLEDGE" ] && { KNOWLEDGE_PATH="$OPT_KNOWLEDGE"; KNOWLEDGE_SOURCE=set; }
if [ "$RUNTIME_AVAILABLE" = 1 ]; then
    set -- find --home "$TARGET_HOME" --out "$FOLDER_FILE"
    [ -n "$REPOS_ARG" ] && set -- "$@" --repos "$REPOS_ARG"
    [ -n "$CREDENTIALS_PATH" ] && set -- "$@" --credentials "$CREDENTIALS_PATH" --credentials-from "$CREDENTIALS_SOURCE"
    [ -n "$KNOWLEDGE_PATH" ] && set -- "$@" --knowledge "$KNOWLEDGE_PATH" --knowledge-from "$KNOWLEDGE_SOURCE"
    node "$SCRIPT_DIR/setup/folders.mjs" "$@" || die2 'Folder search failed'
fi
FOLDER_INTERACTIVE=0
if [ "$OPT_YES" = 0 ] && [ "$OPT_DRY_RUN" = 0 ] && [ -t 0 ]; then FOLDER_INTERACTIVE=1; fi
for _kind in credentials knowledge; do
    if [ "$_kind" = credentials ]; then _value="$CREDENTIALS_PATH"; _source="$CREDENTIALS_SOURCE"
    else _value="$KNOWLEDGE_PATH"; _source="$KNOWLEDGE_SOURCE"; fi
    if [ "$RUNTIME_AVAILABLE" = 1 ]; then
        _value=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d[process.argv[2]].path||"")' "$FOLDER_FILE" "$_kind")
    elif [ -n "$_value" ]; then
        if [ -d "$_value" ]; then _value=$(folder_path "$_value")
        else
            if [ "$_source" = set ]; then _advice="The folder given with --$_kind does not exist: $_value."
            else _advice="The remembered $_kind folder $_value no longer exists; folder search needs Node 18+."; fi
            FOLDER_ADVICE="${FOLDER_ADVICE}${_advice}
"
            _value=""
        fi
    fi
    if [ -z "$_value" ] && [ "$FOLDER_INTERACTIVE" = 1 ]; then
        printf 'Choose the %s folder:\n' "$_kind"
        if [ "$RUNTIME_AVAILABLE" = 1 ]; then
            node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));d[process.argv[2]].candidates.forEach((c,i)=>console.log(`  ${i+1}. ${c.path}`))' "$FOLDER_FILE" "$_kind"
        fi
        _tries=0
        while [ "$_tries" -lt 3 ]; do
            _tries=$((_tries+1))
            printf 'Type a number, a folder path, or press Enter to skip: '
            IFS= read -r _answer || _answer=""
            [ -z "$_answer" ] && break
            case "$_answer" in *[!0-9]*) : ;; *)
                if [ "$RUNTIME_AVAILABLE" = 1 ]; then
                    _candidate=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d[process.argv[2]].candidates[Number(process.argv[3])-1]?.path||"")' "$FOLDER_FILE" "$_kind" "$_answer")
                    [ -n "$_candidate" ] && _answer="$_candidate"
                fi ;;
            esac
            if [ -d "$_answer" ]; then _value=$(folder_path "$_answer"); _source=asked; break; fi
            printf 'That folder does not exist.\n'
        done
    fi
    if [ "$RUNTIME_AVAILABLE" = 1 ]; then
        # Retain the finder's source except when the person answered the prompt.
        node -e 'const fs=require("fs"),f=process.argv[1],d=JSON.parse(fs.readFileSync(f,"utf8")),k=process.argv[2];if(process.argv[4]==="asked"){d[k].path=process.argv[3];d[k].source="asked"}fs.writeFileSync(f,JSON.stringify(d))' "$FOLDER_FILE" "$_kind" "$_value" "$_source"
    fi
    if [ "$_kind" = credentials ]; then CREDENTIALS_PATH="$_value"; CREDENTIALS_SOURCE="$_source"
    else KNOWLEDGE_PATH="$_value"; KNOWLEDGE_SOURCE="$_source"; fi
done
if [ "$RUNTIME_AVAILABLE" = 1 ]; then
    node "$SCRIPT_DIR/setup/folders.mjs" render --decided "$FOLDER_FILE" --out "$FOLDER_DIR" || die2 'Folder rendering failed'
    FOLDERS_JSON=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r={};for(const k of ["credentials","knowledge"])r[k]=d[k].path?{path:d[k].path,source:d[k].source}:null;process.stdout.write(JSON.stringify(r))' "$FOLDER_FILE")
else
    : > "$FOLDER_DIR/folders.md"; : > "$FOLDER_DIR/folders-summary.txt"
    printf '%s\n\n' 'Your folders (remembered by the packet installer and kept on every later run; to change one, run the
installer again with `--credentials <folder>` or `--knowledge <folder>`):' > "$FOLDER_DIR/folders-section.md"
    FOLDERS_JSON='{'
    for _kind in credentials knowledge; do
        if [ "$_kind" = credentials ]; then
            _value="$CREDENTIALS_PATH"; _source="$CREDENTIALS_SOURCE"; _label='Credentials folder'; _section_label='Credentials folder'; _summary_label='Credentials folder'
        else
            _value="$KNOWLEDGE_PATH"; _source="$KNOWLEDGE_SOURCE"; _label='Knowledge base (SecondBrain repository)'; _section_label='Knowledge base (the SecondBrain repository)'; _summary_label='Knowledge base'
            FOLDERS_JSON="$FOLDERS_JSON,"
        fi
        _record=null
        if [ -n "$_value" ]; then
            case "$_source" in set) _how="set with --$_kind" ;; asked) _how='chosen by you' ;; *) _how='kept from the last run' ;; esac
            printf -- '- %s: `%s` (%s)\n' "$_label" "$_value" "$_how" >> "$FOLDER_DIR/folders.md"
            if [ "$_kind" = credentials ]; then
                printf -- '- %s: `%s`. The person\047s logins, keys and account details;\n  use it when a task needs them.\n' "$_section_label" "$(printf '%s' "$_value" | tr '\\' '/')"
            else
                printf -- '- %s: `%s`. Look there for project and background\n  knowledge before asking the person.\n' "$_section_label" "$(printf '%s' "$_value" | tr '\\' '/')"
            fi >> "$FOLDER_DIR/folders-section.md"
            printf '%s: %s (%s)\n' "$_summary_label" "$_value" "$_how" >> "$FOLDER_DIR/folders-summary.txt"
            _record=$(printf '{"path":"%s","source":"%s"}' "$(json_escape "$_value")" "$_source")
        else
            printf -- '- %s: not set; run this installer with --%s <folder> to set it\n' "$_label" "$_kind" >> "$FOLDER_DIR/folders.md"
            printf -- '- %s: not set. Ask the person once where it is, then run\n  the packet installer again with `--%s <folder>` so every later chat has it.\n' "$_section_label" "$_kind" >> "$FOLDER_DIR/folders-section.md"
            printf '%s: not set\n' "$_summary_label" >> "$FOLDER_DIR/folders-summary.txt"
        fi
        FOLDERS_JSON="$FOLDERS_JSON\"$_kind\":$_record"
    done
    FOLDERS_JSON="$FOLDERS_JSON}"
    printf '%s' "$FOLDER_ADVICE" >> "$FOLDER_DIR/folders-summary.txt"
fi
FOLDERS_TEXT=$(cat "$FOLDER_DIR/folders.md")
FOLDERS_SECTION=$(cat "$FOLDER_DIR/folders-section.md")
FOLDERS_SUMMARY=$(cat "$FOLDER_DIR/folders-summary.txt")
rm -f "$FOLDER_DIR/decided.json" "$FOLDER_DIR/folders.md" "$FOLDER_DIR/folders-section.md" "$FOLDER_DIR/folders-summary.txt"
rmdir "$FOLDER_DIR"

CHECK_SUCCESS=0
CHECK_OUTDIR=""
CHECK_FIRST_LINE=""
REFRESH_STATUS="skipped"
REFRESH_REASON="no Node 18+"
REFRESH_AT=""

if [ "$RUNTIME_AVAILABLE" = "1" ]; then
    CHECK_OUTDIR=$(mktemp -d)
    _check_out="$CHECK_OUTDIR/_output.txt"

    _tc_version=""
    _td_version=""
    _tcu_version=""
    _tm_version=""
    printf '%s' "$CLAUDE_VER"  | grep -q '^[0-9]' && _tc_version="$CLAUDE_VER"
    printf '%s' "$CODEX_VER"  | grep -q '^[0-9]' && _td_version="$CODEX_VER"
    printf '%s' "$CURSOR_VER" | grep -q '^[0-9]' && _tcu_version="$CURSOR_VER"
    printf '%s' "$MUSE_VER"   | grep -q '^[0-9]' && _tm_version="$MUSE_VER"

    _check_exit=0
    set -- --packet "$SCRIPT_DIR" --home "$TARGET_HOME" --settings "$SETTINGS_TMP" --out "$CHECK_OUTDIR"
    [ -n "$REPOS_ARG" ] && set -- "$@" --repos "$REPOS_ARG"
    TEAM_CLAUDE="$(tool_for_node "$TOOL_CLAUDE")" \
    TEAM_CODEX="$(tool_for_node "${TOOL_CODEX:-}")" \
    TEAM_CURSOR="$(tool_for_node "${TOOL_CURSOR:-}")" \
    TEAM_MUSE="$(tool_for_node "${TOOL_MUSE:-}")" \
    TEAM_CLAUDE_VERSION="$_tc_version" \
    TEAM_CODEX_VERSION="$_td_version" \
    TEAM_CURSOR_VERSION="$_tcu_version" \
    TEAM_MUSE_VERSION="$_tm_version" \
    TEAM_SETUP_FAIL="${TEAM_SETUP_FAIL:-}" \
    TEAM_SETUP_SKIP="${TEAM_SETUP_SKIP:-}" \
    node "$SCRIPT_DIR/setup/resolve.mjs" "$@" \
        > "$_check_out" 2>&1 || _check_exit=$?

    CHECK_FIRST_LINE=$(head -1 "$_check_out" 2>/dev/null || true)
    REFRESH_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    if [ "$_check_exit" -eq 0 ]; then
        _ok=1
        for _req in local.json routes.md lanes.md consensus.md summary.txt receipt.json repos.md tools.md; do
            [ -f "$CHECK_OUTDIR/$_req" ] || { _ok=0; CHECK_FIRST_LINE="missing output: $_req"; break; }
        done
        # lanes.json required only when relay tool was found
        if [ "$RELAY_COUNT" -gt 0 ] && [ ! -f "$CHECK_OUTDIR/lanes.json" ]; then
            _ok=0; CHECK_FIRST_LINE="missing output: lanes.json"
        fi
        if [ "$_ok" = "1" ]; then
            CHECK_SUCCESS=1
            REFRESH_STATUS="ok"
            REFRESH_REASON=""
        else
            REFRESH_STATUS="failed"
            REFRESH_REASON="$CHECK_FIRST_LINE"
        fi
    else
        REFRESH_STATUS="failed"
        REFRESH_REASON="$CHECK_FIRST_LINE"
    fi
fi

# ─── step 6: degraded mode decision ──────────────────────────────────────────

DEGRADED=0
DEGRADED_REASON=""
KEEP_PREVIOUS=0

if [ "$RUNTIME_AVAILABLE" = "0" ]; then
    DEGRADED=1; DEGRADED_REASON="no Node 18+"
elif [ "$CHECK_SUCCESS" = "0" ]; then
    DEGRADED=1; DEGRADED_REASON="machine check failed: $CHECK_FIRST_LINE"
fi

[ "$DEGRADED" = "1" ] && [ "$PREV_RECEIPT_OURS" = "1" ] && KEEP_PREVIOUS=1

# Decide whether to install the runtime
RUNTIME_INSTALL=0
if [ "$DEGRADED" = "0" ]; then
    RUNTIME_INSTALL=1
elif [ "$DEGRADED" = "1" ] && [ "$KEEP_PREVIOUS" = "0" ] && [ "$RUNTIME_AVAILABLE" = "1" ]; then
    # Fresh install, Node present but check failed: install disabled runtime
    RUNTIME_INSTALL=1
fi

# Per-relay install flags (only in non-degraded mode AND relay tool found)
DO_RELAY_CODEX=0; DO_RELAY_CURSOR=0; DO_RELAY_MUSE=0; DO_RELAY_COUNT=0
if [ "$DEGRADED" = "0" ]; then
    DO_RELAY_CODEX="$RELAY_CODEX"; DO_RELAY_CURSOR="$RELAY_CURSOR"; DO_RELAY_MUSE="$RELAY_MUSE"
    DO_RELAY_COUNT=$((DO_RELAY_CODEX + DO_RELAY_CURSOR + DO_RELAY_MUSE))
fi

# Relay SKIP reason (used for plan display when not installing)
if [ "$RUNTIME_AVAILABLE" = "0" ]; then
    _relay_skip_reason="needs Node 18+"
elif [ "$DEGRADED" = "1" ] && [ "$KEEP_PREVIOUS" = "0" ]; then
    _relay_skip_reason="machine check failed: $CHECK_FIRST_LINE"
else
    _relay_skip_reason="machine check failed: $CHECK_FIRST_LINE"
fi

# Sonnet helper set.
# The machine check's sonnet-helpers.txt decides when it ran and wrote it; otherwise the
# installer's own Claude Code version does (known and older than 2.1.284 -> the 4.6 copies).
SONNET_SRC="claude/agents"
SONNET_SET="5.5"
INSTALLER_SONNET46=0
if printf '%s' "$CLAUDE_VER" | grep -q '^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'; then
    version_ge "$CLAUDE_VER" '2.1.284' || INSTALLER_SONNET46=1
fi
if [ "$CHECK_SUCCESS" = "1" ] && [ -f "$CHECK_OUTDIR/sonnet-helpers.txt" ]; then
    if [ "$(tr -d '\r\n\t ' < "$CHECK_OUTDIR/sonnet-helpers.txt")" = "4.6" ]; then
        SONNET_SRC="claude/agents/sonnet-4-6"; SONNET_SET="4.6"
    fi
elif [ "$INSTALLER_SONNET46" = "1" ]; then
    SONNET_SRC="claude/agents/sonnet-4-6"; SONNET_SET="4.6"
fi
if [ "$INSTALLER_SONNET46" = "1" ]; then
    DEGRADED_SONNET_LINE="- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here, because Claude Code $CLAUDE_VER is older than 2.1.284; update Claude Code and run this installer again for Sonnet 5.5"
else
    DEGRADED_SONNET_LINE="- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available"
fi

# ─── render text blocks ──────────────────────────────────────────────────────

INSTALL_DATE="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
OS_NAME="$(uname -s)"

if [ "$CHECK_SUCCESS" = "1" ]; then
    ROUTES_TEXT="$(cat "$CHECK_OUTDIR/routes.md")"
    LANES_TEXT="$(cat "$CHECK_OUTDIR/lanes.md")"
    CONSENSUS_TEXT="$(cat "$CHECK_OUTDIR/consensus.md")"
    REPOS_TEXT="$(cat "$CHECK_OUTDIR/repos.md")"
    TOOLS_TEXT="$(cat "$CHECK_OUTDIR/tools.md")"
else
    if [ -n "$REPOS_ARG" ]; then REPOS_TEXT="- Repositories: $REPOS_ARG"
    else REPOS_TEXT="- Repositories: not detected (the model check did not run)"; fi
    TOOLS_TEXT="- not checked (the model check did not run)"
    ROUTES_TEXT="- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try; needs Claude Code 2.1.293 or newer
$DEGRADED_SONNET_LINE"
    [ -z "$TOOL_CLAUDE" ] && ROUTES_TEXT='- No Claude helpers: needs Claude Code'
    if [ "$RUNTIME_AVAILABLE" = "0" ]; then
        LANES_TEXT="- none: the relays need Node 18+"
        CONSENSUS_TEXT="off: no Node 18+"
    elif [ "$KEEP_PREVIOUS" = "1" ]; then
        LANES_TEXT="- unchanged: the previous lanes are kept (machine check failed)"
        CONSENSUS_TEXT="unchanged: the previous reviewer setup is kept (machine check failed)"
    else
        LANES_TEXT="- none: the machine check failed"
        CONSENSUS_TEXT="off: the machine check failed"
    fi
fi

# Render templates
initialize_ladder
initialize_codex_section 0 "$PREV_RECEIPT_OURS"
ENTRY_TEXT=$(entry_text)
TMP_BOOTSTRAP=$(mktemp)
TMP_SKILL=$(mktemp)
TMP_PROFILE=$(mktemp)

render_claude_bootstrap "$TMP_BOOTSTRAP"
if [ "$RUNTIME_INSTALL" = "1" ] && [ -f "$SCRIPT_DIR/consensus/skill/consensus/SKILL.md" ]; then
    render_template "$SCRIPT_DIR/consensus/skill/consensus/SKILL.md" "$TMP_SKILL" 1
fi
render_template "$SCRIPT_DIR/policy/profiles/team.md.template" "$TMP_PROFILE" 0

# Render local.json for disabled mode (fresh degraded with Node)
TMP_LOCAL_JSON=""
if [ "$RUNTIME_INSTALL" = "1" ] && [ "$CHECK_SUCCESS" = "0" ]; then
    TMP_LOCAL_JSON=$(mktemp)
    _disabled_reason="machine check failed: $CHECK_FIRST_LINE"
    printf '{"disabled":"%s","seats":{}}\n' "$(json_escape "$_disabled_reason")" > "$TMP_LOCAL_JSON"
fi

# ─── step 7/8: build plan (targets + prune) ──────────────────────────────────

PLAN_TMP=$(mktemp)       # display lines
BACKUP_TMP=$(mktemp)     # files to backup (one path per line)
APPLY_TMP=$(mktemp)      # work items: ACTION\tSRC\tDST\tHASH
KEEP_TMP=$(mktemp)       # kept files: REASON\tHASH\tPATH
CURRENT_TARGETS=$(mktemp)  # all target DST paths (one per line, for pruning exclusion)
RECEIPT_FILES_TMP=$(mktemp)  # HASH\tPATH for receipt

# Helper: add a file target
add_target() {
    local src="$1" dst="$2"
    local h st
    if ! is_owned_inside "$dst"; then
        # A target reached through a link that leads outside the owned locations is never written.
        printf '%-24s  %s\n' "SKIP (a link leads outside the owned folders)" "$dst" >> "$PLAN_TMP"
        return 0
    fi
    h=$(hash_file "$src")
    st=$(file_status "$dst" "$h")
    printf '%s\n' "$dst" >> "$CURRENT_TARGETS"
    printf '%-24s  %s\n' "$st" "$dst" >> "$PLAN_TMP"
    if [ "$st" != "UNCHANGED" ]; then
        [ -f "$dst" ] && printf '%s\n' "$dst" >> "$BACKUP_TMP"
        printf 'COPY\t%s\t%s\t%s\n' "$src" "$dst" "$h" >> "$APPLY_TMP"
    else
        printf 'UNCHANGED\t%s\t%s\t%s\n' "$src" "$dst" "$h" >> "$APPLY_TMP"
    fi
}

# Policy files
add_target "$SCRIPT_DIR/policy/POLICY.md" "$POLICY_DIR/POLICY.md"

_profile_st="CREATE"
if ! is_owned_inside "$POLICY_DIR/profiles/team.md"; then
    _profile_st="SKIP (a link leads outside the owned folders)"
elif [ -f "$POLICY_DIR/profiles/team.md" ]; then
    _n1=$(profile_norm < "$TMP_PROFILE")
    _n2=$(profile_norm < "$POLICY_DIR/profiles/team.md")
    if [ "$_n1" = "$_n2" ]; then _profile_st="UNCHANGED"; else _profile_st="UPDATE"; fi
fi
printf '%s\n' "$POLICY_DIR/profiles/team.md" >> "$CURRENT_TARGETS"
printf '%-24s  %s\n' "$_profile_st" "$POLICY_DIR/profiles/team.md" >> "$PLAN_TMP"
if [ "${_profile_st#SKIP}" != "$_profile_st" ]; then
    rm -f "$TMP_PROFILE"
elif [ "$_profile_st" != "UNCHANGED" ]; then
    [ -f "$POLICY_DIR/profiles/team.md" ] && printf '%s\n' "$POLICY_DIR/profiles/team.md" >> "$BACKUP_TMP"
    printf 'RENDER_PROFILE\t%s\t%s\t\n' "$TMP_PROFILE" "$POLICY_DIR/profiles/team.md" >> "$APPLY_TMP"
else
    rm -f "$TMP_PROFILE"
    printf 'UNCHANGED\t%s\t%s\t\n' "$TMP_PROFILE" "$POLICY_DIR/profiles/team.md" >> "$APPLY_TMP"
fi

# Agent helper definitions (use the Sonnet 4.6 copies when this machine's Claude Code
# is older than 2.1.284; haiku-helper always comes from claude/agents)
if [ -n "$TOOL_CLAUDE" ]; then
for _f in explore implementer researcher verifier; do
    add_target "$SCRIPT_DIR/$SONNET_SRC/${_f}.md" "$AGENTS_DIR/${_f}.md"
done
add_target "$SCRIPT_DIR/claude/agents/haiku-helper.md" "$AGENTS_DIR/haiku-helper.md"

# CLAUDE.md splice
printf '%s\n' "$CLAUDE_MD" >> "$CURRENT_TARGETS"
_claude_st="CREATE"
if [ -f "$CLAUDE_MD" ]; then
    _cnt=$(grep -c '^## Delegation (shared rulebook)[[:space:]]*$' "$CLAUDE_MD" 2>/dev/null) || _cnt=0
    if [ "$_cnt" -gt 1 ]; then
        printf 'ERROR: CLAUDE.md has more than one "## Delegation (shared rulebook)" section\n' >&2
        rm -f "$TMP_BOOTSTRAP" "$TMP_SKILL" "$TMP_PROFILE" "$PLAN_TMP" "$BACKUP_TMP" "$APPLY_TMP" "$KEEP_TMP" "$CURRENT_TARGETS" "$RECEIPT_FILES_TMP" "$SETTINGS_TMP"
        exit 2
    fi
    if [ "$_cnt" -eq 1 ]; then   # no section yet: CREATE (the file is still backed up first)
        _chk=$(mktemp)
        cp "$CLAUDE_MD" "$_chk"
        splice_claude_md "$_chk" "$TMP_BOOTSTRAP" "install"
        if cmp -s "$_chk" "$CLAUDE_MD"; then _claude_st="UNCHANGED"; else _claude_st="UPDATE"; fi
        rm -f "$_chk"
    fi
fi
printf '%-24s  %s (delegation section)\n' "$_claude_st" "$CLAUDE_MD" >> "$PLAN_TMP"
if [ "$_claude_st" != "UNCHANGED" ]; then
    [ -f "$CLAUDE_MD" ] && printf '%s\n' "$CLAUDE_MD" >> "$BACKUP_TMP"
    printf 'SPLICE\t%s\t%s\t\n' "$TMP_BOOTSTRAP" "$CLAUDE_MD" >> "$APPLY_TMP"
else
    rm -f "$TMP_BOOTSTRAP"
    printf 'UNCHANGED\t\t%s\t\n' "$CLAUDE_MD" >> "$APPLY_TMP"
fi
else
    # A tool disappearing does not revoke the packet's existing ownership.
    for _missing_part in "$AGENTS_DIR/explore.md" "$AGENTS_DIR/implementer.md" "$AGENTS_DIR/researcher.md" "$AGENTS_DIR/verifier.md" "$AGENTS_DIR/haiku-helper.md" "$CLAUDE_MD"; do
        _missing_hash=$(awk -F '\t' -v p="$_missing_part" '$2==p {print $1;exit}' "$PREV_FILES_TMP")
        printf '%s\n' "$_missing_part" >> "$CURRENT_TARGETS"
        if [ -n "$_missing_hash" ] && is_owned_inside "$_missing_part"; then
            printf '%-24s  %s\n' 'KEEP (Claude Code not found; left as installed)' "$_missing_part" >> "$PLAN_TMP"
            printf '%s\t%s\t%s\n' 'Claude Code not found; left as installed' "$_missing_hash" "$_missing_part" >> "$KEEP_TMP"
        else
            printf '%-24s  %s\n' 'SKIP (needs Claude Code)' "$_missing_part" >> "$PLAN_TMP"
        fi
    done
fi

case "$CODEX_ACTION" in SKIP|KEEP) _codex_label="$CODEX_ACTION ($CODEX_REASON)" ;; *) _codex_label="$CODEX_ACTION" ;; esac
printf '%-24s  %s (delegation section)\n' "$_codex_label" "$CODEX_AGENTS" >> "$PLAN_TMP"
[ "$CODEX_ACTION" = UPDATE ] && printf '%s\n' "$CODEX_AGENTS" >> "$BACKUP_TMP"

# Runtime + local.json
if [ "$RUNTIME_INSTALL" = "1" ]; then
    # Consensus files (except tests/ and skill/)
    while IFS= read -r _csrc; do
        _rel="${_csrc#${SCRIPT_DIR}/consensus/}"
        case "$_rel" in tests/*|skill/*|BUILD-BRIEF.txt) continue ;; esac
        _cdst="$RUNTIME_DIR/$_rel"
        [ "$_cdst" = "$LOCAL_JSON" ] && continue  # local.json handled separately
        add_target "$_csrc" "$_cdst"
    done < <(find "$SCRIPT_DIR/consensus" -type f | sort)

    # local.json
    printf '%s\n' "$LOCAL_JSON" >> "$CURRENT_TARGETS"
    if [ "$CHECK_SUCCESS" = "1" ]; then
        _lj_src="$CHECK_OUTDIR/local.json"
    else
        _lj_src="$TMP_LOCAL_JSON"
    fi
    if ! is_owned_inside "$LOCAL_JSON"; then
        printf '%-24s  %s\n' "SKIP (a link leads outside the owned folders)" "$LOCAL_JSON" >> "$PLAN_TMP"
    elif [ -f "$_lj_src" ]; then
        _lj_h=$(hash_file "$_lj_src")
        _lj_st=$(file_status "$LOCAL_JSON" "$_lj_h")
        printf '%-24s  %s\n' "$_lj_st" "$LOCAL_JSON" >> "$PLAN_TMP"
        if [ "$_lj_st" != "UNCHANGED" ]; then
            [ -f "$LOCAL_JSON" ] && printf '%s\n' "$LOCAL_JSON" >> "$BACKUP_TMP"
            printf 'COPY\t%s\t%s\t%s\n' "$_lj_src" "$LOCAL_JSON" "$_lj_h" >> "$APPLY_TMP"
        else
            printf 'UNCHANGED\t%s\t%s\t%s\n' "$_lj_src" "$LOCAL_JSON" "$_lj_h" >> "$APPLY_TMP"
        fi
    fi

    # Consensus skill copies
    if [ -f "$SCRIPT_DIR/consensus/skill/consensus/SKILL.md" ] && [ -s "$TMP_SKILL" ]; then
        _ssh=$(hash_file "$TMP_SKILL")
        for _sdir in "$SKILLS_CLAUDE/consensus" "$SKILLS_AGENTS/consensus"; do
            _sdst="$_sdir/SKILL.md"
            printf '%s\n' "$_sdst" >> "$CURRENT_TARGETS"
            if ! is_owned_inside "$_sdst"; then
                printf '%-24s  %s\n' "SKIP (a link leads outside the owned folders)" "$_sdst" >> "$PLAN_TMP"
                continue
            fi
            _sst=$(file_status "$_sdst" "$_ssh")
            printf '%-24s  %s\n' "$_sst" "$_sdst" >> "$PLAN_TMP"
            if [ "$_sst" != "UNCHANGED" ]; then
                [ -f "$_sdst" ] && printf '%s\n' "$_sdst" >> "$BACKUP_TMP"
                printf 'RENDER_SKILL\t%s\t%s\t%s\n' "$TMP_SKILL" "$_sdst" "$_ssh" >> "$APPLY_TMP"
            else
                printf 'UNCHANGED\t%s\t%s\t%s\n' "$TMP_SKILL" "$_sdst" "$_ssh" >> "$APPLY_TMP"
            fi
        done
    fi

    _ledger_st="CREATE"; [ -d "$LEDGER_DIR" ] && _ledger_st="UNCHANGED"
    printf '%-24s  %s  (ledger directory)\n' "$_ledger_st" "$LEDGER_DIR" >> "$PLAN_TMP"
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    # Keep every runtime/local.json file from previous receipt
    _keep_reason="machine check failed"
    [ "$RUNTIME_AVAILABLE" = "0" ] && _keep_reason="needs Node 18+"
    _keep_label="KEEP (${_keep_reason})"
    while IFS= read -r _entry; do
        [ -z "$_entry" ] && continue
        _fh="${_entry%%	*}"; _fp="${_entry#*	}"
        case "$_fp" in
            "${RUNTIME_DIR}/"*|"${SKILLS_CLAUDE}/consensus/"*|"${SKILLS_AGENTS}/consensus/"*)
                is_owned_inside "$_fp" || continue
                printf '%s\n' "$_fp" >> "$CURRENT_TARGETS"
                printf '%-24s  %s\n' "$_keep_label" "$_fp" >> "$PLAN_TMP"
                printf '%s\t%s\t%s\n' "$_keep_reason" "$_fh" "$_fp" >> "$KEEP_TMP"
                ;;
        esac
    done < "$PREV_FILES_TMP"
else
    # Fresh degraded: SKIP runtime
    if [ "$RUNTIME_AVAILABLE" = "0" ]; then
        printf '%-24s  %s\n' "SKIP (needs Node 18+)" "$RUNTIME_DIR" >> "$PLAN_TMP"
        printf '%-24s  %s\n' "SKIP (needs Node 18+)" "$SKILLS_CLAUDE/consensus/SKILL.md" >> "$PLAN_TMP"
        printf '%-24s  %s\n' "SKIP (needs Node 18+)" "$SKILLS_AGENTS/consensus/SKILL.md" >> "$PLAN_TMP"
    else
        printf '%-24s  %s\n' "SKIP (machine check failed)" "$RUNTIME_DIR" >> "$PLAN_TMP"
        printf '%-24s  %s\n' "SKIP (machine check failed)" "$SKILLS_CLAUDE/consensus/SKILL.md" >> "$PLAN_TMP"
        printf '%-24s  %s\n' "SKIP (machine check failed)" "$SKILLS_AGENTS/consensus/SKILL.md" >> "$PLAN_TMP"
    fi
fi

# Relay folders this packet did not install are left as they are.
KEPT_RELAYS=""
for _rname in codex-delegate cursor-delegate muse-delegate delegate-setup; do
    if [ -d "$SKILLS_CLAUDE/$_rname" ] && ! cut -f2 "$PREV_FILES_TMP" 2>/dev/null | grep -qF "$SKILLS_CLAUDE/$_rname/"; then
        KEPT_RELAYS="$KEPT_RELAYS $_rname"
        printf '%-24s  %s\n' "KEEP (installed by you; not replaced)" "$SKILLS_CLAUDE/$_rname" >> "$PLAN_TMP"
        case "$_rname" in
            codex-delegate)  DO_RELAY_CODEX=0 ;;
            cursor-delegate) DO_RELAY_CURSOR=0 ;;
            muse-delegate)   DO_RELAY_MUSE=0 ;;
        esac
    fi
done
_relay_present=$((DO_RELAY_CODEX + DO_RELAY_CURSOR + DO_RELAY_MUSE))
DO_RELAY_COUNT=$_relay_present
case " $KEPT_RELAYS " in *" delegate-setup "*) DO_SETUP=0 ;; *) DO_SETUP=1 ;; esac

# Relay skills (per-file targets)
INSTALLED_RELAYS=""
for _rname in codex-delegate cursor-delegate muse-delegate; do
    _rflag=0
    case "$_rname" in
        codex-delegate)  _rflag="$DO_RELAY_CODEX" ;;
        cursor-delegate) _rflag="$DO_RELAY_CURSOR" ;;
        muse-delegate)   _rflag="$DO_RELAY_MUSE" ;;
    esac

    case " $KEPT_RELAYS " in *" $_rname "*) continue ;; esac
    if [ "$_rflag" = "1" ]; then
        # Install per-file
        INSTALLED_RELAYS="${INSTALLED_RELAYS} ${_rname}"
        _rsrc="$SCRIPT_DIR/skills/$_rname"
        _rdst="$SKILLS_CLAUDE/$_rname"
        while IFS= read -r _rf; do
            _rrel="${_rf#${_rsrc}/}"
            _rout="$_rdst/$_rrel"
            add_target "$_rf" "$_rout"
        done < <(find "$_rsrc" -type f | sort)
    elif [ "$KEEP_PREVIOUS" = "1" ]; then
        # Keep files from previous receipt
        _keep_reason="machine check failed"
        [ "$RUNTIME_AVAILABLE" = "0" ] && _keep_reason="needs Node 18+"
        _keep_label="KEEP (${_keep_reason})"
        _found_any=0
        while IFS= read -r _entry; do
            [ -z "$_entry" ] && continue
            _fh="${_entry%%	*}"; _fp="${_entry#*	}"
            case "$_fp" in "${SKILLS_CLAUDE}/${_rname}/"*)
                is_owned_inside "$_fp" || continue
                printf '%s\n' "$_fp" >> "$CURRENT_TARGETS"
                printf '%-24s  %s\n' "$_keep_label" "$_fp" >> "$PLAN_TMP"
                printf '%s\t%s\t%s\n' "$_keep_reason" "$_fh" "$_fp" >> "$KEEP_TMP"
                _found_any=1 ;;
            esac
        done < "$PREV_FILES_TMP"
        [ "$_found_any" = "1" ] && INSTALLED_RELAYS="${INSTALLED_RELAYS} ${_rname}"
    else
        # Skip
        case "$_rname" in
            codex-delegate)  _sfx="codex not found" ;;
            cursor-delegate) _sfx="cursor-agent not found" ;;
            muse-delegate)   _sfx="muse not found" ;;
        esac
        if [ "$RELAY_CODEX" = "0" ] && [ "$_rname" = "codex-delegate" ]; then _sfx="codex not found"
        elif [ "$RELAY_CURSOR" = "0" ] && [ "$_rname" = "cursor-delegate" ]; then _sfx="cursor-agent not found"
        elif [ "$RELAY_MUSE" = "0" ] && [ "$_rname" = "muse-delegate" ]; then _sfx="muse not found"
        else _sfx="$_relay_skip_reason"; fi
        printf '%-24s  %s\n' "SKIP ($_sfx)" "$SKILLS_CLAUDE/$_rname" >> "$PLAN_TMP"
    fi
done

# delegate-setup (when at least one relay)
_dssrc="$SCRIPT_DIR/skills/delegate-setup"
_dsdst="$SKILLS_CLAUDE/delegate-setup"
if [ "$DO_SETUP" = "0" ]; then
    :
elif [ "$DO_RELAY_COUNT" -gt 0 ]; then
    INSTALLED_RELAYS="${INSTALLED_RELAYS} delegate-setup"
    while IFS= read -r _dsf; do
        _dsrel="${_dsf#${_dssrc}/}"
        add_target "$_dsf" "$_dsdst/$_dsrel"
    done < <(find "$_dssrc" -type f | sort)
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    _keep_reason="machine check failed"
    [ "$RUNTIME_AVAILABLE" = "0" ] && _keep_reason="needs Node 18+"
    _keep_label="KEEP (${_keep_reason})"
    _found_any=0
    while IFS= read -r _entry; do
        [ -z "$_entry" ] && continue
        _fh="${_entry%%	*}"; _fp="${_entry#*	}"
        case "$_fp" in "${SKILLS_CLAUDE}/delegate-setup/"*)
            is_owned_inside "$_fp" || continue
            printf '%s\n' "$_fp" >> "$CURRENT_TARGETS"
            printf '%-24s  %s\n' "$_keep_label" "$_fp" >> "$PLAN_TMP"
            printf '%s\t%s\t%s\n' "$_keep_reason" "$_fh" "$_fp" >> "$KEEP_TMP"
            _found_any=1 ;;
        esac
    done < "$PREV_FILES_TMP"
    [ "$_found_any" = "1" ] && INSTALLED_RELAYS="${INSTALLED_RELAYS} delegate-setup"
else
    printf '%-24s  %s\n' "SKIP (no relay tools)" "$_dsdst" >> "$PLAN_TMP"
fi

# Lane file (config.json)
if { [ "$DO_RELAY_COUNT" -gt 0 ] || [ -n "$KEPT_RELAYS" ]; } && [ "$CHECK_SUCCESS" = "1" ] && [ -f "$CHECK_OUTDIR/lanes.json" ]; then
    add_target "$CHECK_OUTDIR/lanes.json" "$LANES_FILE"
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    while IFS= read -r _entry; do
        [ -z "$_entry" ] && continue
        _fh="${_entry%%	*}"; _fp="${_entry#*	}"
        [ "$_fp" = "$LANES_FILE" ] || continue
        is_owned_inside "$_fp" || continue
        printf '%s\n' "$_fp" >> "$CURRENT_TARGETS"
        _keep_reason="machine check failed"
        [ "$RUNTIME_AVAILABLE" = "0" ] && _keep_reason="needs Node 18+"
        printf '%-24s  %s\n' "KEEP (${_keep_reason})" "$_fp" >> "$PLAN_TMP"
        printf '%s\t%s\t%s\n' "$_keep_reason" "$_fh" "$_fp" >> "$KEEP_TMP"
    done < "$PREV_FILES_TMP"
elif [ "$RELAY_COUNT" -gt 0 ]; then
    printf '%-24s  %s\n' "SKIP ($_relay_skip_reason)" "$LANES_FILE" >> "$PLAN_TMP"
else
    printf '%-24s  %s\n' "SKIP (no relay tools)" "$LANES_FILE" >> "$PLAN_TMP"
fi

# Settings file
if [ -n "$UNAVAIL_IDS" ]; then
    add_target "$SETTINGS_TMP" "$SETTINGS_FILE"
elif [ "$OPT_CLEAR_UNAVAILABLE" = "1" ] && [ -f "$SETTINGS_FILE" ]; then
    printf '%s\n' "$SETTINGS_FILE" >> "$CURRENT_TARGETS"
    printf '%-24s  %s\n' "REMOVE" "$SETTINGS_FILE" >> "$PLAN_TMP"
    printf '%s\n' "$SETTINGS_FILE" >> "$BACKUP_TMP"
    printf 'REMOVE\t\t%s\t\n' "$SETTINGS_FILE" >> "$APPLY_TMP"
fi

# ─── step 8: pruning ─────────────────────────────────────────────────────────

if [ "$PREV_RECEIPT_OURS" = "1" ]; then
    while IFS= read -r _entry; do
        [ -z "$_entry" ] && continue
        _ph="${_entry%%	*}"; _pp="${_entry#*	}"
        [ "$_pp" = "$CODEX_AGENTS" ] && continue # separate containment and ownership
        # Already a current target or kept?
        grep -qxF "$_pp" "$CURRENT_TARGETS" && continue
        # Owned-and-inside check
        is_owned_inside "$_pp" || { printf 'outside the owned folders; ignored: %s\n' "$_pp"; continue; }
        # CLAUDE.md is never pruned
        [ "$_pp" = "$CLAUDE_MD" ] && continue
        [ -f "$_pp" ] || continue  # missing: ignore
        _cur_h=$(hash_file "$_pp")
        if [ "$_cur_h" = "$_ph" ]; then
            printf '%-24s  %s\n' "REMOVE" "$_pp" >> "$PLAN_TMP"
            printf '%s\n' "$_pp" >> "$BACKUP_TMP"
            printf 'REMOVE\t\t%s\t\n' "$_pp" >> "$APPLY_TMP"
        else
            printf '%-24s  %s\n' "KEEP (changed since install)" "$_pp" >> "$PLAN_TMP"
            # Stays listed with its previous hash, so it stays ours.
            printf '%s\t%s\t%s\n' "changed since install" "$_ph" "$_pp" >> "$KEEP_TMP"
        fi
    done < "$PREV_FILES_TMP"
fi

# ─── step 11: plan display ───────────────────────────────────────────────────

printf '\n=== Installation plan ===\n'
cat "$PLAN_TMP"

# Version line
printf '\n'
if [ "$PREV_RECEIPT_OURS" = "1" ] && [ -n "$PREV_PACKET_VERSION" ]; then
    if pkt_eq "$PREV_PACKET_VERSION" "$PACKET_VERSION" 2>/dev/null; then
        printf 'Re-installing %s\n' "$PACKET_VERSION"
    elif pkt_gt "$PREV_PACKET_VERSION" "$PACKET_VERSION" 2>/dev/null; then
        printf 'Downgrading from %s to %s (allowed)\n' "$PREV_PACKET_VERSION" "$PACKET_VERSION"
    else
        printf 'Upgrading from %s to %s\n' "$PREV_PACKET_VERSION" "$PACKET_VERSION"
    fi
else
    printf 'New install of %s\n' "$PACKET_VERSION"
fi

printf '\n=== Tools detected ===\n'
printf '  claude:       %s\n' "$CLAUDE_VER_DISPLAY"
printf '  node:         %s\n' "$NODE_VER_DISPLAY"
printf '  codex:        %s\n' "$CODEX_VER_DISPLAY"
printf '  cursor-agent: %s\n' "$CURSOR_VER_DISPLAY"
printf '  muse:         %s\n' "$MUSE_VER_DISPLAY"
printf '%s\n' "$ENTRY_TEXT"
case "$CODEX_REASON" in CODEX_HOME*) printf 'Add ## Delegation (shared rulebook) to %s/AGENTS.md yourself.\n' "$CODEX_HOME" ;; esac

if [ -n "$UNAVAIL_DISPLAY" ]; then
    printf '\nDeclared unavailable models: %s\n' "$UNAVAIL_DISPLAY"
    printf '  To change: run installer with --unavailable or --clear-unavailable\n'
fi

if [ "$CHECK_SUCCESS" = "1" ] && [ -f "$CHECK_OUTDIR/summary.txt" ]; then
    printf '\n=== Machine check summary ===\n'
    while IFS= read -r _summary; do
        printf '%s\n' "$_summary"
        case "$_summary" in Repositories:*) printf '%s\n' "$FOLDERS_SUMMARY" ;; esac
    done < "$CHECK_OUTDIR/summary.txt"
else
    printf '%s\n%s\n' "$REPOS_TEXT" "$FOLDERS_SUMMARY"
fi

if [ "$OPT_DRY_RUN" = "1" ]; then
    install_ladder
    rm -f "$TMP_BOOTSTRAP" "$TMP_SKILL" "$TMP_PROFILE" "$PLAN_TMP" "$BACKUP_TMP" \
          "$APPLY_TMP" "$KEEP_TMP" "$CURRENT_TARGETS" "$RECEIPT_FILES_TMP" "$SETTINGS_TMP"
    [ -n "$CHECK_OUTDIR" ] && rm -rf "$CHECK_OUTDIR"
    printf '\n(dry-run: nothing written)\n'
    exit 0
fi

# ─── confirm ─────────────────────────────────────────────────────────────────

if [ "$FOLDER_INTERACTIVE" = 1 ]; then
    printf '\nPress Enter to install, or close this window to cancel: '
    read -r _reply || true
fi

# ─── step 12: backup phase ────────────────────────────────────────────────────

BACKUP_STAMP=$(date -u '+%Y%m%d-%H%M%S')
BACKUP_DIR="$BACKUP_BASE/$BACKUP_STAMP"

_backup_needed=0
[ -s "$BACKUP_TMP" ] && _backup_needed=1

if [ "$_backup_needed" = "1" ]; then
    mkdir -p "$BACKUP_DIR" 2>/dev/null || die "cannot create backup directory ($BACKUP_DIR); check that $BACKUP_BASE is not a regular file"
    while IFS= read -r _bf; do
        [ -f "$_bf" ] || continue
        backup_file "$_bf" || die "backup failed for $_bf; nothing has been changed"
    done < "$BACKUP_TMP"
fi

# ─── step 12: apply phase ─────────────────────────────────────────────────────

_skill_src_used=""

while IFS= read -r _wline; do
    [ -z "$_wline" ] && continue
    _wact="${_wline%%	*}"
    _wrest="${_wline#*	}"
    _wsrc="${_wrest%%	*}"
    _wrest2="${_wrest#*	}"
    _wdst="${_wrest2%%	*}"
    _whash="${_wrest2#*	}"

    case "$_wact" in
        COPY)
            mkdir -p "$(dirname "$_wdst")"
            cp "$_wsrc" "$_wdst"
            ;;
        RENDER_PROFILE)
            : # Written after the ladder result is known.
            ;;
        RENDER_SKILL)
            mkdir -p "$(dirname "$_wdst")"
            render_template "$SCRIPT_DIR/consensus/skill/consensus/SKILL.md" "$_wdst" 1
            ;;
        SPLICE)
            mkdir -p "$(dirname "$_wdst")"
            TMP_BS2=$(mktemp)
            render_claude_bootstrap "$TMP_BS2"
            splice_claude_md "$_wdst" "$TMP_BS2" "install"
            rm -f "$TMP_BS2" "$_wsrc"
            ;;
        REMOVE)
            rm -f "$_wdst"
            ;;
        UNCHANGED)
            # Nothing to do; but clean up temp files passed as src for profile
            case "$_wdst" in
                */profiles/team.md) : ;; # Retain the temporary profile until the ladder step.
            esac
            ;;
    esac
done < "$APPLY_TMP"

write_codex_section
ENTRY_TEXT=$(entry_text)

# Clean up bootstrap temp if SPLICE didn't use it (UNCHANGED path)
rm -f "$TMP_BOOTSTRAP"
rm -f "$TMP_SKILL"
[ -n "$TMP_LOCAL_JSON" ] && rm -f "$TMP_LOCAL_JSON"
rm -f "$SETTINGS_TMP"

# Create ledger directory
[ "$RUNTIME_INSTALL" = "1" ] && mkdir -p "$LEDGER_DIR"

# The core/runtime/relays are in place. The ladder is independent of the machine-check result.
install_ladder
if is_owned_inside "$POLICY_DIR/profiles/team.md"; then
    render_template "$SCRIPT_DIR/policy/profiles/team.md.template" "$TMP_PROFILE" 0
    _final_profile="$POLICY_DIR/profiles/team.md"
    _same_profile=0
    if [ -f "$_final_profile" ] && [ "$(profile_norm < "$TMP_PROFILE")" = "$(profile_norm < "$_final_profile")" ]; then
        _same_profile=1
    fi
    if [ "$_same_profile" = "0" ]; then
        if [ -f "$_final_profile" ] && ! grep -Fxq "$_final_profile" "$BACKUP_TMP"; then
            mkdir -p "$BACKUP_DIR" || die 'cannot create backup directory for the team profile'
            backup_file "$_final_profile" || die 'could not back up the team profile'
            _backup_needed=1
        fi
        mkdir -p "$(dirname "$_final_profile")"
        cp "$TMP_PROFILE" "$_final_profile" || die 'could not write the team profile'
        [ "$(hash_file "$TMP_PROFILE")" = "$(hash_file "$_final_profile")" ] || die 'post-write hash mismatch for team profile'
    fi
fi
rm -f "$TMP_PROFILE"

# ─── verify written files + build receipt files list ─────────────────────────

while IFS= read -r _wline; do
    [ -z "$_wline" ] && continue
    _wact="${_wline%%	*}"
    _wrest="${_wline#*	}"
    _wsrc="${_wrest%%	*}"
    _wrest2="${_wrest#*	}"
    _wdst="${_wrest2%%	*}"
    _whash="${_wrest2#*	}"

    case "$_wact" in
        COPY)
            [ -f "$_wdst" ] || die "ERROR: written file missing: $_wdst"
            _ah=$(hash_file "$_wdst")
            [ "$_ah" = "$_whash" ] || die "ERROR: post-write hash mismatch for $_wdst"
            printf '%s\t%s\n' "$_ah" "$_wdst" >> "$RECEIPT_FILES_TMP"
            ;;
        RENDER_SKILL)
            [ -f "$_wdst" ] || die "ERROR: rendered skill file missing: $_wdst"
            _ah=$(hash_file "$_wdst")
            printf '%s\t%s\n' "$_ah" "$_wdst" >> "$RECEIPT_FILES_TMP"
            ;;
        RENDER_PROFILE)
            [ -f "$_wdst" ] || die "ERROR: written file missing: $_wdst"
            _ah=$(hash_file "$_wdst")
            printf '%s\t%s\n' "$_ah" "$_wdst" >> "$RECEIPT_FILES_TMP"
            ;;
        SPLICE)
            # CLAUDE.md: no strict hash expected; record current hash
            [ -f "$_wdst" ] || die "ERROR: CLAUDE.md missing after splice"
            _ah=$(hash_file "$_wdst")
            printf '%s\t%s\n' "$_ah" "$_wdst" >> "$RECEIPT_FILES_TMP"
            ;;
        UNCHANGED)
            # Record current hash
            [ -f "$_wdst" ] || continue
            _ah=$(hash_file "$_wdst")
            printf '%s\t%s\n' "$_ah" "$_wdst" >> "$RECEIPT_FILES_TMP"
            ;;
        REMOVE)
            : # removed; not in receipt
            ;;
    esac
done < "$APPLY_TMP"

# Add KEEP files to receipt
while IFS= read -r _kline; do
    [ -z "$_kline" ] && continue
    _kreason="${_kline%%	*}"
    _krest="${_kline#*	}"
    _khash="${_krest%%	*}"
    _kpath="${_krest#*	}"
    printf '%s\t%s\n' "$_khash" "$_kpath" >> "$RECEIPT_FILES_TMP"
done < "$KEEP_TMP"

if [ "$CODEX_RECORD_JSON" != null ]; then
    codex_skip_reason
    if [ -z "$CODEX_CURRENT_REASON" ] && [ "$CODEX_RECORD_PATH" = "$CODEX_CANONICAL" ] && [ -f "$CODEX_AGENTS" ]; then
        printf '%s\t%s\n' "$(hash_file "$CODEX_AGENTS")" "$CODEX_AGENTS" >> "$RECEIPT_FILES_TMP"
    else
        _old_codex_hash=$(awk -F '\t' -v p="$CODEX_AGENTS" '$2==p {print $1;exit}' "$PREV_FILES_TMP")
        [ -n "$_old_codex_hash" ] && printf '%s\t%s\n' "$_old_codex_hash" "$CODEX_AGENTS" >> "$RECEIPT_FILES_TMP"
    fi
fi

# Remove owned empty dirs left by pruning
for _od in "$RUNTIME_DIR" "$POLICY_DIR/profiles" \
           "$SKILLS_CLAUDE/consensus" "$SKILLS_AGENTS/consensus" \
           "$SKILLS_CLAUDE/codex-delegate" "$SKILLS_CLAUDE/cursor-delegate" \
           "$SKILLS_CLAUDE/muse-delegate" "$SKILLS_CLAUDE/delegate-setup"; do
    [ -d "$_od" ] || continue
    find "$_od" -depth -type d -exec rmdir {} \; 2>/dev/null || true
done

# ─── step 12: write receipt (schema 2) ───────────────────────────────────────

# Determine consensus/lanes values for receipt
if [ "$CHECK_SUCCESS" = "1" ] && [ -f "$CHECK_OUTDIR/receipt.json" ]; then
    _ck_content=$(cat "$CHECK_OUTDIR/receipt.json")
    _receipt_consensus=$(printf '%s' "$_ck_content" | sed 's/.*"consensus":\({[^}]*}\).*/\1/')
    _receipt_lanes=$(printf '%s' "$_ck_content" | sed 's/.*"lanes":\({[^}]*}\).*/\1/')
    [ -z "$_receipt_consensus" ] && _receipt_consensus="null"
    [ -z "$_receipt_lanes" ]     && _receipt_lanes="null"
    _receipt_repos=$(printf '%s' "$_ck_content" | sed -E 's/.*"repos":(null|\{[^}]*\}).*/\1/')
elif [ "$KEEP_PREVIOUS" = "1" ] && [ "$PREV_SCHEMA" = "2" ]; then
    _receipt_consensus="$PREV_CONSENSUS_VAL"
    _receipt_lanes="$PREV_LANES_VAL"
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    # Previous was schema 1: unknown
    _receipt_consensus="null"
    _receipt_lanes="null"
else
    # Fresh degraded
    _off_reason="$CONSENSUS_TEXT"
    _receipt_consensus=$(printf '{"grade":"off","pair":[],"reason":"%s"}' "$(json_escape "$_off_reason")")
    _receipt_lanes="{}"
fi

if [ -z "${_receipt_repos:-}" ] || [ "$_receipt_repos" = "null" ]; then
    if [ -n "$REPOS_ARG" ]; then _receipt_repos=$(printf '{"path":"%s","count":null}' "$(json_escape "$REPOS_ARG")")
    else _receipt_repos="null"; fi
fi

# Build unavailable JSON array
_unavail_json=""
if [ -n "$UNAVAIL_IDS" ]; then
    _unavail_json=$(printf '%s' "$UNAVAIL_IDS" | grep -E '^[A-Za-z0-9._-]+$' | \
        sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')
fi

mkdir -p "$(dirname "$RECEIPT_FILE")"
{
    printf '{\n'
    printf '  "schema": 2,\n'
    printf '  "packetVersion": "%s",\n'         "$(json_escape "$PACKET_VERSION")"
    if [ "$PREV_RECEIPT_OURS" = "1" ] && [ -n "$PREV_PACKET_VERSION" ]; then
        printf '  "previousPacketVersion": "%s",\n' "$(json_escape "$PREV_PACKET_VERSION")"
    else
        printf '  "previousPacketVersion": null,\n'
    fi
    printf '  "installedAt": "%s",\n'           "$(json_escape "$INSTALL_DATE")"
    printf '  "platform": "%s",\n'              "$(json_escape "$OS_NAME")"
    printf '  "home": "%s",\n'                  "$(json_escape "$TARGET_HOME")"
    printf '  "tools": {\n'
    printf '    "claude": "%s",\n'              "$(json_escape "$CLAUDE_VER_DISPLAY")"
    printf '    "node": "%s",\n'                "$(json_escape "$NODE_VER_DISPLAY")"
    printf '    "codex": "%s",\n'               "$(json_escape "$CODEX_VER_DISPLAY")"
    printf '    "cursor": "%s",\n'              "$(json_escape "$CURSOR_VER_DISPLAY")"
    printf '    "muse": "%s"\n'                 "$(json_escape "$MUSE_VER_DISPLAY")"
    printf '  },\n'
    printf '  "unavailable": [%s],\n' "$_unavail_json"
    if [ "$REFRESH_STATUS" = "ok" ]; then
        printf '  "refresh": {"status":"ok","at":"%s"},\n' "$(json_escape "$REFRESH_AT")"
    elif [ "$REFRESH_STATUS" = "failed" ]; then
        printf '  "refresh": {"status":"failed","reason":"%s","at":"%s"},\n' \
            "$(json_escape "$REFRESH_REASON")" "$(json_escape "$REFRESH_AT")"
    else
        printf '  "refresh": {"status":"skipped","reason":"%s","at":"%s"},\n' \
            "$(json_escape "$REFRESH_REASON")" "$(json_escape "$INSTALL_DATE")"
    fi
    printf '  "consensus": %s,\n' "$_receipt_consensus"
    printf '  "lanes": %s,\n' "$_receipt_lanes"
    printf '  "repos": %s,\n' "$_receipt_repos"
    printf '  "folders": %s,\n' "$FOLDERS_JSON"
    printf '  "codexSection": %s,\n' "$CODEX_RECORD_JSON"
    printf '  "ladder": {"owned":%s,"lastInstalled":%s,"lastAttempt":{"status":"%s","reason":"%s","at":"%s"}},\n' \
        "$LADDER_OWNED" "$LADDER_LAST_INSTALLED" "$(json_escape "$LADDER_STATUS")" "$(json_escape "$LADDER_REASON")" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "relays": ['
    _first_r=1
    for _r in $INSTALLED_RELAYS; do
        if [ "$_first_r" = "1" ]; then printf '"%s"' "$(json_escape "$_r")"; _first_r=0
        else printf ', "%s"' "$(json_escape "$_r")"; fi
    done
    printf '],\n'
    printf '  "files": {\n'
    _first_f=1
    while IFS= read -r _entry; do
        [ -z "$_entry" ] && continue
        _fh="${_entry%%	*}"; _fp="${_entry#*	}"
        if [ "$_first_f" = "1" ]; then
            printf '    "%s": "%s"' "$(json_escape "$_fp")" "$(json_escape "$_fh")"; _first_f=0
        else
            printf ',\n    "%s": "%s"' "$(json_escape "$_fp")" "$(json_escape "$_fh")"
        fi
    done < "$RECEIPT_FILES_TMP"
    printf '\n  },\n'
    if [ "$_backup_needed" = "1" ]; then
        printf '  "backupDir": "%s"\n' "$(json_escape "$BACKUP_DIR")"
    else
        printf '  "backupDir": %s\n' "$PREV_BACKUP_DIR_JSON"
    fi
    printf '}\n'
} > "$RECEIPT_FILE"

rm -f "$PLAN_TMP" "$BACKUP_TMP" "$APPLY_TMP" "$KEEP_TMP" "$CURRENT_TARGETS" "$RECEIPT_FILES_TMP" "$PREV_FILES_TMP"
[ -n "$CODEX_ORIGINAL_TMP" ] && rm -f "$CODEX_ORIGINAL_TMP" "$CODEX_RESULT_TMP"
[ -n "$CHECK_OUTDIR" ] && rm -rf "$CHECK_OUTDIR"

# ─── step 13: post-install doctor ────────────────────────────────────────────

if [ "$RUNTIME_INSTALL" = "1" ] && [ -f "$REFEREE_PATH" ]; then
    printf '\n=== Referee doctor ===\n'
    node "$REFEREE_PATH" doctor --human
fi

# ─── step 14: summary ────────────────────────────────────────────────────────

printf '\n=== Summary ===\n'
ladder_summary
printf '%s\n' "$ENTRY_TEXT"
case "$CODEX_REASON" in CODEX_HOME*) printf 'Add ## Delegation (shared rulebook) to %s/AGENTS.md yourself.\n' "$CODEX_HOME" ;; esac

# Model check line
if [ "$REFRESH_STATUS" = "ok" ]; then
    printf 'Model check: done\n'
elif [ "$REFRESH_STATUS" = "failed" ] && [ "$KEEP_PREVIOUS" = "1" ]; then
    printf 'Model check: failed (%s); your previous reviewer and lane setup is kept unchanged\n' "$REFRESH_REASON"
elif [ "$REFRESH_STATUS" = "failed" ]; then
    printf 'Model check: failed (%s); reviews are off until it succeeds\n' "$REFRESH_REASON"
else
    printf 'Model check: skipped (no Node 18+)\n'
fi

# Muse contributor protection, from the relay file actually installed here (this packet's, one kept from before, or
# the person's own). Only this packet's own relay (same SHA-256) is known to pass --contributor-mode off on every run;
# another relay that merely mentions the flag cannot be confirmed.
_muse_relay="$SKILLS_CLAUDE/muse-delegate/scripts/relay.mjs"
_pkt_muse_relay="$SCRIPT_DIR/skills/muse-delegate/scripts/relay.mjs"
if [ -f "$_muse_relay" ]; then
    _muse_relay_ours=0
    if [ -f "$_pkt_muse_relay" ]; then
        _mh_installed="$(hash_file "$_muse_relay")"; _mh_packet="$(hash_file "$_pkt_muse_relay")"
        if [ -n "$_mh_installed" ] && [ "$_mh_installed" = "$_mh_packet" ]; then _muse_relay_ours=1; fi
    fi
    if [ "$_muse_relay_ours" = "1" ]; then
        if [ "$MUSE_CONTRIBUTOR_ON" = "1" ]; then
            printf 'WARNING: Muse contributor mode is ON in %s. The Muse relay at %s switches it off for every job it runs; what you run in Muse yourself is not covered, so switch it off in Muse too.\n' "$_muse_settings" "$_muse_relay"
        fi
    elif grep -Fq '"--contributor-mode", "off"' "$_muse_relay" 2>/dev/null; then
        printf "WARNING: the Muse relay at %s is not this packet's relay (it was kept from before or installed by you). It mentions --contributor-mode off, but the installer cannot confirm that it switches off Meta's contributor tier for its jobs. If you installed it yourself, move it away and run this installer again to get the packet's relay.\n" "$_muse_relay"
    else
        printf "WARNING: the Muse relay at %s does not switch off Meta's contributor tier (it was kept from before or installed by you), so its jobs follow this machine's Muse setting. If you installed it yourself, move it away and run this installer again to get the packet's relay.\n" "$_muse_relay"
    fi
elif [ "$MUSE_CONTRIBUTOR_ON" = "1" ]; then
    printf 'WARNING: Muse contributor mode is ON in %s and no Muse relay is installed here to switch it off: switch it off in Muse.\n' "$_muse_settings"
fi
# The Muse relay refuses a Muse older than 1.4.15, the first version known to accept --contributor-mode off.
case "${MUSE_VER:-}" in
    [0-9]*.[0-9]*.[0-9]*)
        _mv_old=0
        IFS=. read -r _mv1 _mv2 _mv3 <<EOF
$MUSE_VER
EOF
        if [ "$_mv1" -lt 1 ] 2>/dev/null; then _mv_old=1
        elif [ "$_mv1" -eq 1 ] 2>/dev/null && [ "$_mv2" -lt 4 ] 2>/dev/null; then _mv_old=1
        elif [ "$_mv1" -eq 1 ] 2>/dev/null && [ "$_mv2" -eq 4 ] 2>/dev/null && [ "$_mv3" -lt 15 ] 2>/dev/null; then _mv_old=1
        fi
        if [ "$_mv_old" = "1" ]; then
            printf 'WARNING: Muse %s is older than 1.4.15: the Muse relay refuses it (it needs --contributor-mode off), so every Muse relay job fails until Muse is updated.\n' "$MUSE_VER"
        fi
        ;;
esac

printf 'Installed:\n'
printf '  Rulebook and team profile: %s\n'      "$POLICY_DIR"
if [ -z "$TOOL_CLAUDE" ]; then
    printf '  Claude helpers and CLAUDE.md section: skipped (needs Claude Code); previously installed parts are kept\n'
elif [ "$SONNET_SET" = "4.6" ]; then
    printf '  Sonnet helper definitions: %s (Claude Sonnet 4.6: Claude Code older than 2.1.284)\n' "$AGENTS_DIR"
else
    printf '  Sonnet helper definitions: %s (Claude Sonnet 5.5)\n' "$AGENTS_DIR"
fi
[ -n "$TOOL_CLAUDE" ] && printf '  Delegation section added to: %s\n' "$CLAUDE_MD"
if [ "$RUNTIME_INSTALL" = "1" ]; then
    printf '  Consensus referee: %s\n'           "$RUNTIME_DIR"
    printf '  Consensus skill: %s/consensus\n'   "$SKILLS_CLAUDE"
    printf '  Ledger directory: %s\n'            "$LEDGER_DIR"
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    printf '  Consensus runtime: kept unchanged (previous setup)\n'
else
    printf '  Skipped: consensus referee, consensus skill\n'
fi
if [ "$DO_RELAY_COUNT" -gt 0 ]; then
    printf '  Relay skills:%s\n' "$INSTALLED_RELAYS"
    printf '  Lane file: %s\n' "$LANES_FILE"
elif [ "$KEEP_PREVIOUS" = "1" ]; then
    printf '  Relay skills: kept unchanged (previous setup)\n'
else
    printf '  Skipped: relay skills and lane file\n'
fi

if [ -n "$UNAVAIL_DISPLAY" ]; then
    printf '\nDeclared unavailable models: %s\n' "$UNAVAIL_DISPLAY"
    printf '  To add more: --unavailable <ids>\n'
    printf '  To reset: --clear-unavailable\n'
fi

if [ "$_backup_needed" = "1" ] && [ -d "$BACKUP_DIR" ]; then
    printf '\nBackups of replaced/removed files: %s\n' "$BACKUP_DIR"
else
    printf '\nNo files were replaced or removed (no backups needed)\n'
fi

printf '\nTo uninstall: bash install.sh --uninstall --home "%s"\n' "$TARGET_HOME"
printf 'After you update Claude Code, Codex or Cursor, or log in to one of them, run this installer again: it re-checks your models.\n'
printf 'Next step: start a new session in your agent.\n'
