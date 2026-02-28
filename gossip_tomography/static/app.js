// ═══════════════════════════════════════════════════════════════
//  Gossip Tomography — Interactive LN Gossip Propagation Analyzer
//  BTC++ Hackathon 2026
//
//  4-quadrant dashboard with cross-highlighting:
//    Q1  Propagation Replay (radial canvas)
//    Q2  World Map (Leaflet)
//    Q3  Surveillance Suspects
//    Q4  Co-located Peers
// ═══════════════════════════════════════════════════════════════

const DATA_BASE = "data";

// ─── Data ───────────────────────────────────────────────────────
let peers = {};
let wavefronts = {};
let messages = [];
let communities = {};
let leaks = {};
let summary = {};

// ─── Selection state ────────────────────────────────────────────
let highlightedPeers = new Set();   // pubkeys currently highlighted across all panels
let currentMsg = null;
let currentWavefront = [];

// ─── Animation ──────────────────────────────────────────────────
let animFrame = null;
let animStart = null;
let animPlaying = false;
let animSpeed = 1;

// ─── Canvas ─────────────────────────────────────────────────────
let canvas, ctx, W, H;
let peerPositions = {};
let peerStates = {};

// ─── Map ────────────────────────────────────────────────────────
let leafletMap = null;
let mapMarkers = {};          // pubkey → L.circleMarker
let mapHighlightLayer = null;

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════

window.addEventListener("load", async () => {
    canvas = document.getElementById("viz-canvas");
    ctx = canvas.getContext("2d");

    await loadData();
    resizeCanvas();
    initMap();
    setupUI();

    window.addEventListener("resize", () => {
        resizeCanvas();
        computeLayout();
        drawFrame(0);
        leafletMap?.invalidateSize();
    });

    // Auto-select first message
    if (messages.length > 0) selectMessage(messages[0]);
});

// ═══════════════════════════════════════════════════════════════
//  DATA
// ═══════════════════════════════════════════════════════════════

async function loadData() {
    const [p, w, m, c, l, s] = await Promise.all([
        fetchJSON(`${DATA_BASE}/peers.json`),
        fetchJSON(`${DATA_BASE}/wavefronts.json`),
        fetchJSON(`${DATA_BASE}/messages.json`),
        fetchJSON(`${DATA_BASE}/communities.json`),
        fetchJSON(`${DATA_BASE}/leaks.json`),
        fetchJSON(`${DATA_BASE}/summary.json`),
    ]);
    peers = p; wavefronts = w; communities = c; leaks = l; summary = s;

    // Normalize messages dict → array, enrich from wavefronts
    if (!Array.isArray(m)) {
        messages = Object.entries(m).map(([hash, meta]) => {
            const wf = wavefronts[hash] || {};
            return {
                hash, ...meta,
                peer_count: wf.total_peers || (wf.arrivals ? wf.arrivals.length : 0),
                time_spread_ms: wf.spread_ms || 0,
            };
        });
    } else {
        messages = m;
    }

    // Header stats
    document.getElementById("stat-peers").textContent = summary.total_peers || Object.keys(peers).length;
    document.getElementById("stat-msgs").textContent = summary.total_messages?.toLocaleString() || "—";
    document.getElementById("stat-ips").textContent = summary.peers_with_ip || "—";
    document.getElementById("stat-suspects").textContent = (leaks.first_responders || []).length;
    document.getElementById("stat-coloc").textContent = (leaks.colocation || []).length;

    // Badges
    document.getElementById("replay-badge").textContent = messages.length + " msgs";
    document.getElementById("map-badge").textContent = (summary.peers_with_ip || 0) + " located";
    document.getElementById("suspect-badge").textContent = (leaks.first_responders || []).length;
    document.getElementById("coloc-badge").textContent = (leaks.colocation || []).length + " groups";
}

async function fetchJSON(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } catch (e) { console.warn(`Failed: ${url}`, e); return {}; }
}

// ═══════════════════════════════════════════════════════════════
//  CANVAS LAYOUT
// ═══════════════════════════════════════════════════════════════

function resizeCanvas() {
    const wrap = document.getElementById("canvas-wrap");
    if (!wrap) return;
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    computeLayout();
}

function computeLayout() {
    const byCommunity = {};
    for (const [ph, p] of Object.entries(peers)) {
        const c = p.community || "unknown";
        (byCommunity[c] ??= []).push(ph);
    }
    const cKeys = Object.keys(byCommunity).sort();
    const total = Object.keys(peers).length;
    if (!total) return;

    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.42;
    let aOff = 0;

    for (const ck of cKeys) {
        const cp = byCommunity[ck];
        const sector = (cp.length / total) * Math.PI * 2;
        for (let i = 0; i < cp.length; i++) {
            const frac = cp.length > 1 ? i / (cp.length - 1) : 0.5;
            const angle = aOff + frac * sector;
            const avgPct = peers[cp[i]]?.avg_arrival_pct ?? 0.5;
            const r = maxR * (0.15 + 0.85 * avgPct);
            peerPositions[cp[i]] = {
                x: cx + Math.cos(angle) * r,
                y: cy + Math.sin(angle) * r,
                angle, r,
            };
        }
        aOff += sector + 0.04;
    }
}

// ═══════════════════════════════════════════════════════════════
//  UI SETUP
// ═══════════════════════════════════════════════════════════════

function setupUI() {
    // Message filter
    document.querySelectorAll(".msg-filter button").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".msg-filter button").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderMessageList(btn.dataset.type);
        });
    });

    // Playback
    document.getElementById("btn-play").addEventListener("click", togglePlay);
    document.getElementById("btn-reset").addEventListener("click", resetAnim);
    document.getElementById("speed-slider").addEventListener("input", e => {
        animSpeed = parseFloat(e.target.value);
        document.getElementById("speed-label").textContent = animSpeed.toFixed(1) + "×";
    });

    // Canvas hover
    canvas.addEventListener("mousemove", handleCanvasHover);
    canvas.addEventListener("mouseleave", () => hideTooltip());
    canvas.addEventListener("click", handleCanvasClick);

    renderMessageList("all");
    renderSuspects();
    renderColocation();
    renderAllMapMarkers();
}

// ═══════════════════════════════════════════════════════════════
//  Q1 — MESSAGE LIST
// ═══════════════════════════════════════════════════════════════

function renderMessageList(filterType) {
    const list = document.getElementById("msg-list");
    list.innerHTML = "";
    const filtered = filterType === "all"
        ? messages
        : messages.filter(m => m.type === filterType);
    const sorted = [...filtered].sort((a, b) => b.peer_count - a.peer_count).slice(0, 100);

    for (const msg of sorted) {
        const el = document.createElement("div");
        el.className = "msg-item" + (currentMsg?.hash === msg.hash ? " active" : "");
        const ts = msg.type === "channel_announcement" ? "chan_ann"
            : msg.type === "node_announcement" ? "node_ann" : "chan_upd";
        el.innerHTML = `
            <span class="type-badge type-${ts}">${ts}</span>
            <span class="peers-count">${msg.peer_count}p · ${(msg.time_spread_ms / 1000).toFixed(1)}s</span>`;
        el.addEventListener("click", () => selectMessage(msg));
        list.appendChild(el);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Q3 — SUSPECTS
// ═══════════════════════════════════════════════════════════════

function renderSuspects() {
    const container = document.getElementById("suspect-list");
    container.innerHTML = "";
    const frList = (leaks.first_responders || [])
        .sort((a, b) => (a.avg_arrival_pct || 0) - (b.avg_arrival_pct || 0));

    for (const fr of frList) {
        const pk = fr.pubkey || "";
        const card = document.createElement("div");
        card.className = "suspect-card";
        card.dataset.pubkey = pk;
        const pct = (fr.top5_pct || 0).toFixed(0);
        const isTor = fr.is_tor;
        card.innerHTML = `
            <div class="alias">${escHtml(fr.alias || pk.slice(0, 16) + "…")}</div>
            <div class="meta">
                <span class="tag ${isTor ? "tag-tor" : "tag-clearnet"}">${isTor ? "🧅 TOR" : "🌐 CLEARNET"}</span>
                ${fr.ip ? `<span style="color:#555">${fr.ip}</span>` : ""}
                · <strong>${(fr.messages_seen || 0).toLocaleString()}</strong> msgs seen
            </div>
            <div class="score-bar">
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <span class="bar-label">top-5: ${pct}%</span>
            </div>`;
        card.addEventListener("click", () => highlightPeer(pk));
        card.addEventListener("mouseenter", () => showPeerTooltip(pk, card));
        card.addEventListener("mouseleave", () => hideTooltip());
        container.appendChild(card);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Q4 — CO-LOCATION
// ═══════════════════════════════════════════════════════════════

function renderColocation() {
    const container = document.getElementById("coloc-list");
    container.innerHTML = "";
    const clList = (leaks.colocation || []).sort((a, b) => (b.count || 0) - (a.count || 0));

    for (const cl of clList) {
        const peerList = cl.peers || [];
        const pubkeys = peerList.map(p => typeof p === "string" ? p : p.pubkey);
        const card = document.createElement("div");
        card.className = "coloc-card";
        card.dataset.pubkeys = JSON.stringify(pubkeys);

        const chipHtml = peerList.map(p => {
            const pk = typeof p === "string" ? p : p.pubkey;
            const alias = typeof p === "object" ? (p.alias || pk.slice(0, 10)) : (peers[pk]?.alias || pk.slice(0, 10));
            return `<span class="chip" data-pubkey="${pk}">${escHtml(alias)}</span>`;
        }).join("");

        card.innerHTML = `
            <div class="subnet">${cl.prefix || "?"} <span class="count-badge">(${cl.count || pubkeys.length} nodes)</span></div>
            <div class="peer-chips">${chipHtml}</div>`;

        // Click card → highlight all peers in group
        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("chip")) return; // handled below
            highlightPeers(pubkeys);
        });
        // Click individual chip → highlight single peer
        card.querySelectorAll(".chip").forEach(chip => {
            chip.addEventListener("click", (e) => {
                e.stopPropagation();
                highlightPeer(chip.dataset.pubkey);
            });
        });
        container.appendChild(card);
    }
}

// ═══════════════════════════════════════════════════════════════
//  CROSS-HIGHLIGHTING ENGINE
// ═══════════════════════════════════════════════════════════════

function highlightPeer(pubkey) {
    highlightPeers([pubkey]);
}

function highlightPeers(pubkeys) {
    highlightedPeers = new Set(pubkeys);
    updateAllHighlights();
}

function clearHighlight() {
    highlightedPeers.clear();
    updateAllHighlights();
}

function updateAllHighlights() {
    // Q1 — Canvas: redraw
    drawFrame(getCurrentElapsed());

    // Q2 — Map: highlight markers
    updateMapHighlights();

    // Q3 — Suspects: highlight matching cards
    document.querySelectorAll(".suspect-card").forEach(card => {
        card.classList.toggle("highlighted", highlightedPeers.has(card.dataset.pubkey));
    });
    // Scroll to first highlighted
    const highlightedSuspect = document.querySelector(".suspect-card.highlighted");
    if (highlightedSuspect) highlightedSuspect.scrollIntoView({ block: "nearest", behavior: "smooth" });

    // Q4 — Co-location: highlight cards/chips that contain highlighted peers
    document.querySelectorAll(".coloc-card").forEach(card => {
        const pks = JSON.parse(card.dataset.pubkeys || "[]");
        const hasMatch = pks.some(pk => highlightedPeers.has(pk));
        card.classList.toggle("highlighted", hasMatch);
        card.querySelectorAll(".chip").forEach(chip => {
            chip.classList.toggle("highlighted", highlightedPeers.has(chip.dataset.pubkey));
        });
    });
    const highlightedColoc = document.querySelector(".coloc-card.highlighted");
    if (highlightedColoc) highlightedColoc.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ═══════════════════════════════════════════════════════════════
//  Q2 — MAP
// ═══════════════════════════════════════════════════════════════

function initMap() {
    leafletMap = L.map("map-container", {
        center: [25, 0],
        zoom: 2,
        zoomControl: false,
        attributionControl: false,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 18,
    }).addTo(leafletMap);
    L.control.zoom({ position: "bottomright" }).addTo(leafletMap);
    setTimeout(() => leafletMap.invalidateSize(), 200);
}

function renderAllMapMarkers() {
    if (!leafletMap) return;
    for (const [pk, peer] of Object.entries(peers)) {
        if (!peer.lat || !peer.lon) continue;
        const color = getCommunityColor(peer.community);
        const marker = L.circleMarker([peer.lat, peer.lon], {
            radius: 4,
            fillColor: color,
            color: "#0a0a0f",
            fillOpacity: 0.7,
            weight: 1,
        });
        marker.bindTooltip(
            `<b>${escHtml(peer.alias || "?")}</b><br>${peer.ip || "tor"}<br>${peer.city || ""}, ${peer.country || ""}`,
        );
        marker.on("click", () => highlightPeer(pk));
        marker.addTo(leafletMap);
        mapMarkers[pk] = marker;
    }
}

function updateMapHighlights() {
    for (const [pk, marker] of Object.entries(mapMarkers)) {
        const isHL = highlightedPeers.has(pk);
        const peer = peers[pk];
        const baseColor = getCommunityColor(peer?.community);
        marker.setStyle({
            radius: isHL ? 8 : 4,
            fillColor: isHL ? "#ff6b35" : baseColor,
            color: isHL ? "#ff6b35" : "#0a0a0f",
            fillOpacity: highlightedPeers.size === 0 ? 0.7 : (isHL ? 1 : 0.15),
            weight: isHL ? 2 : 1,
        });
        if (isHL) marker.bringToFront();
    }
    // If single peer highlighted with coords, pan to it
    if (highlightedPeers.size === 1) {
        const pk = [...highlightedPeers][0];
        const peer = peers[pk];
        if (peer?.lat && peer?.lon) {
            leafletMap.flyTo([peer.lat, peer.lon], 5, { duration: 0.5 });
        }
    } else if (highlightedPeers.size > 1) {
        // Fit bounds to all highlighted peers with coords
        const coords = [...highlightedPeers]
            .map(pk => peers[pk])
            .filter(p => p?.lat && p?.lon)
            .map(p => [p.lat, p.lon]);
        if (coords.length > 1) {
            leafletMap.flyToBounds(L.latLngBounds(coords).pad(0.3), { duration: 0.5 });
        } else if (coords.length === 1) {
            leafletMap.flyTo(coords[0], 5, { duration: 0.5 });
        }
    }
}

// Update map colors based on current wavefront arrival
function updateMapForWavefront() {
    if (!currentWavefront.length) return;
    const maxDelay = currentMsg?.time_spread_ms || 5000;

    for (const [pk, marker] of Object.entries(mapMarkers)) {
        const state = peerStates[pk];
        if (!state || state.delay === Infinity) {
            marker.setStyle({ fillOpacity: 0.1, radius: 3 });
        } else {
            const frac = Math.min(1, state.delay / maxDelay);
            const color = lerpColor("#ff6b35", "#457b9d", frac);
            marker.setStyle({
                fillColor: color,
                fillOpacity: 0.8,
                radius: 5,
            });
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  MESSAGE SELECTION & ANIMATION
// ═══════════════════════════════════════════════════════════════

function selectMessage(msg) {
    currentMsg = msg;
    const wfData = wavefronts[msg.hash] || wavefronts[String(msg.hash)] || {};
    currentWavefront = Array.isArray(wfData) ? wfData : (wfData.arrivals || []);

    // Init peer states
    peerStates = {};
    for (const ph of Object.keys(peers)) peerStates[ph] = { delay: Infinity };
    for (const entry of currentWavefront) {
        const ph = entry.peer || entry.peer_hash;
        if (peerStates[ph]) peerStates[ph].delay = entry.delay_ms;
    }

    // Highlight active in list
    document.querySelectorAll(".msg-item").forEach(el => el.classList.remove("active"));
    // Find and activate (best effort since list may be filtered)
    document.querySelectorAll(".msg-item").forEach((el, i) => {
        // match by index in filtered list — not perfect, but works
    });

    clearHighlight();
    resetAnim();
    drawFrame(0);
    updateMapForWavefront();
}

function togglePlay() {
    if (animPlaying) {
        animPlaying = false;
        cancelAnimationFrame(animFrame);
        document.getElementById("btn-play").textContent = "▶";
    } else {
        animPlaying = true;
        animStart = performance.now();
        document.getElementById("btn-play").textContent = "⏸";
        animLoop();
    }
}

function resetAnim() {
    animPlaying = false;
    animStart = null;
    cancelAnimationFrame(animFrame);
    document.getElementById("btn-play").textContent = "▶";
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("time-display").textContent = "0.00s";
}

function getCurrentElapsed() {
    if (!animStart || !animPlaying) return 0;
    return (performance.now() - animStart) * animSpeed;
}

function animLoop() {
    if (!animPlaying) return;
    const elapsed = getCurrentElapsed();
    const maxDelay = currentMsg?.time_spread_ms || 5000;

    if (elapsed > maxDelay + 500) {
        animPlaying = false;
        document.getElementById("btn-play").textContent = "▶";
        drawFrame(maxDelay);
        document.getElementById("progress-fill").style.width = "100%";
        return;
    }

    drawFrame(elapsed);
    document.getElementById("progress-fill").style.width = Math.min(100, elapsed / maxDelay * 100) + "%";
    document.getElementById("time-display").textContent = (elapsed / 1000).toFixed(2) + "s";
    animFrame = requestAnimationFrame(animLoop);
}

// ═══════════════════════════════════════════════════════════════
//  CANVAS DRAWING
// ═══════════════════════════════════════════════════════════════

function drawFrame(elapsedMs) {
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.42;
    const hasHL = highlightedPeers.size > 0;

    // Concentric rings
    for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * i / 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#1a1a2e";
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // Observer dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6b35";
    ctx.fill();

    // Wavefront ring
    if (currentWavefront.length > 0 && elapsedMs > 0) {
        const maxD = currentMsg?.time_spread_ms || 5000;
        const frac = Math.min(1, elapsedMs / maxD);
        ctx.beginPath();
        ctx.arc(cx, cy, frac * maxR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,107,53,${0.25 * (1 - frac)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Peers
    for (const [ph, pos] of Object.entries(peerPositions)) {
        const state = peerStates[ph];
        const peer = peers[ph];
        if (!pos) continue;

        const isLit = state && state.delay <= elapsedMs;
        const isHL = highlightedPeers.has(ph);
        const dimmed = hasHL && !isHL;
        const color = getCommunityColor(peer?.community);

        if (isLit) {
            const freshness = Math.max(0, 1 - (elapsedMs - state.delay) / 2000);

            // Glow
            if (freshness > 0 && !dimmed) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 3 + freshness * 6, 0, Math.PI * 2);
                ctx.fillStyle = (isHL ? "#ff6b35" : color) + "25";
                ctx.fill();
            }

            // Dot
            ctx.beginPath();
            const r = isHL ? 5 : 3;
            ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
            ctx.fillStyle = dimmed ? "#2a2a3e" : (isHL ? "#ff6b35" : color);
            ctx.globalAlpha = dimmed ? 0.3 : 1;
            ctx.fill();
            ctx.globalAlpha = 1;

            // Highlight ring
            if (isHL) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
                ctx.strokeStyle = "#ff6b35";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            // Label for highlighted peers
            if (isHL && peer) {
                ctx.font = "bold 9px monospace";
                ctx.fillStyle = "#ff6b35";
                ctx.textAlign = "left";
                ctx.fillText(peer.alias || ph.slice(0, 8), pos.x + 10, pos.y + 3);
            }
        } else {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, isHL ? 4 : 1.5, 0, Math.PI * 2);
            ctx.fillStyle = isHL ? "#ff6b3580" : (dimmed ? "#151520" : "#1e1e2e");
            ctx.fill();
            if (isHL) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
                ctx.strokeStyle = "#ff6b3550";
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  CANVAS INTERACTION
// ═══════════════════════════════════════════════════════════════

function findClosestPeer(mx, my, threshold = 15) {
    let closest = null, closestDist = threshold;
    for (const [ph, pos] of Object.entries(peerPositions)) {
        const d = Math.hypot(pos.x - mx, pos.y - my);
        if (d < closestDist) { closest = ph; closestDist = d; }
    }
    return closest;
}

function handleCanvasHover(e) {
    const rect = canvas.getBoundingClientRect();
    const pk = findClosestPeer(e.clientX - rect.left, e.clientY - rect.top);
    if (pk) {
        const peer = peers[pk] || {};
        const state = peerStates[pk] || {};
        const isSuspect = (leaks.first_responders || []).some(fr => (fr.pubkey || "") === pk);
        const tt = document.getElementById("tooltip");
        tt.innerHTML = `
            <div class="t-alias">${escHtml(peer.alias || "Unknown")} ${isSuspect ? "⚠️" : ""}</div>
            <div class="t-pubkey">${pk}</div>
            ${peer.ip ? `<div class="t-ip">🌐 ${peer.ip} · ${peer.city || ""} ${peer.country || ""}</div>` : '<div style="color:#555">🧅 Tor-only</div>'}
            <div class="t-score">
                Avg arrival: ${((peer.avg_arrival_pct || 0) * 100).toFixed(1)}th pct<br>
                ${state.delay < Infinity ? `This msg: +${state.delay.toFixed(0)}ms` : "Not in this message"}
            </div>
            ${isSuspect ? '<div class="t-warn">⚠ Abnormally fast relay — possible monitoring node</div>' : ""}`;
        tt.style.display = "block";
        tt.style.left = (e.clientX + 12) + "px";
        tt.style.top = (e.clientY - 10) + "px";
    } else {
        hideTooltip();
    }
}

function handleCanvasClick(e) {
    const rect = canvas.getBoundingClientRect();
    const pk = findClosestPeer(e.clientX - rect.left, e.clientY - rect.top);
    if (pk) {
        if (highlightedPeers.has(pk) && highlightedPeers.size === 1) {
            clearHighlight();
        } else {
            highlightPeer(pk);
        }
    } else {
        clearHighlight();
    }
}

// ═══════════════════════════════════════════════════════════════
//  TOOLTIP
// ═══════════════════════════════════════════════════════════════

function showPeerTooltip(pk, refEl) {
    const peer = peers[pk] || {};
    const tt = document.getElementById("tooltip");
    const isSuspect = (leaks.first_responders || []).some(fr => (fr.pubkey || "") === pk);
    tt.innerHTML = `
        <div class="t-alias">${escHtml(peer.alias || pk.slice(0, 16))}</div>
        <div class="t-pubkey">${pk}</div>
        ${peer.ip ? `<div class="t-ip">🌐 ${peer.ip} · ${peer.city || ""} ${peer.country || ""}</div>` : '<div style="color:#555">🧅 Tor-only</div>'}
        <div class="t-score">
            Avg arrival: ${((peer.avg_arrival_pct || 0) * 100).toFixed(1)}th pct ·
            Msgs: ${(peer.messages_seen || 0).toLocaleString()}
        </div>
        ${isSuspect ? '<div class="t-warn">⚠ Consistently fast relay</div>' : ""}`;
    tt.style.display = "block";
    const rect = refEl.getBoundingClientRect();
    tt.style.left = (rect.right + 8) + "px";
    tt.style.top = rect.top + "px";
}

function hideTooltip() {
    document.getElementById("tooltip").style.display = "none";
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function getCommunityColor(communityId) {
    if (!communityId) return "#555";
    const c = communities[communityId];
    if (c?.color) return c.color;
    const palette = ["#ff6b35","#2a9d8f","#e9c46a","#457b9d","#e63946","#a855f7","#06d6a0","#ef476f","#118ab2","#ffd166"];
    let h = 0;
    for (let i = 0; i < communityId.length; i++) h = ((h << 5) - h + communityId.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
}

function lerpColor(a, b, t) {
    const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
    const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `#${((rr << 16) | (rg << 8) | rb).toString(16).padStart(6, "0")}`;
}

function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}
