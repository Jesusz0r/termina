#!/bin/bash
# Check domain availability across TLDs using whois.
# Usage: check-domains.sh name1 name2 ...
# Prints: NAME  .com: AVAILABLE/TAKEN  .dev: ... etc.
check() {
  local name="$1" tld="$2"
  case "$tld" in
    com) out=$(whois -h whois.verisign-grs.com "$name.com" 2>/dev/null) ;;
    dev|app) out=$(whois -h whois.nic.google "$name.$tld" 2>/dev/null) ;;
    io) out=$(whois -h whois.nic.io "$name.io" 2>/dev/null) ;;
    ai) out=$(whois -h whois.nic.ai "$name.ai" 2>/dev/null) ;;
    co) out=$(whois -h whois.nic.co "$name.co" 2>/dev/null) ;;
  esac
  if echo "$out" | grep -qiE "no match|not found|no data found|domain not found"; then
    echo "AVAILABLE"
  else
    echo "taken"
  fi
}

for name in "$@"; do
  line="$name"
  for tld in com dev io ai app co; do
    res=$(check "$name" "$tld")
    line="$line  $tld: $res"
    sleep 0.3
  done
  echo "$line"
done