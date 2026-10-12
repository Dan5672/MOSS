#!/bin/sh
# Starts the toolbox. With MOSS_TOOLBOX_INTERNET=false (docs/hardening.md), it first limits the container to
# private addresses, then drops to the unprivileged node user: the toolbox itself can't change the rules back.
set -eu

if [ "${MOSS_TOOLBOX_INTERNET:-true}" = "false" ]; then
  export XTABLES_LOCKFILE=/tmp/xtables.lock
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4 255.255.255.255/32; do
    iptables -A OUTPUT -d "$net" -j ACCEPT
  done
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -j REJECT
  for net in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
    ip6tables -A OUTPUT -d "$net" -j ACCEPT
  done
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -j REJECT
  echo "toolbox: internet access off (private addresses only)"
fi

# Run as node with no capabilities; the scanners keep their own file capabilities (see the Dockerfile). SETUID and
# SETGID stay in the bounding set (dropping them needs SETPCAP), but the image has no setuid programs to use them.
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all node dist/main.js
