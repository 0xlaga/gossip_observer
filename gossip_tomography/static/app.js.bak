// Gossip Tomography — Interactive LN Privacy Leak Visualizer
// BTC++ Hackathon 2026

const DATA_BASE = "data";

// ─── State ──────────────────────────────────────────────────────
let peers = {};           // peer_hash → { alias, ip, community, ... }
let wavefronts = {};      // msg_hash → [ { peer_hash, delay_ms } ]
let messages = [];        // [ { hash, type, peer_count, time_spread_ms, ... } ]
let communities = {};     // community_id → { label, color, ... }
let leaks = {};           // { first_responders, colocation_suspects }
let summary = {};

let currentMsg = null;
let currentWavefront = null;
let animFrame = null;
let animStart = null;
let animPlaying = false;
let animSpeed = 1;
let currentView = "radial"; // "radial" | "map"

// Canvas / layout
let canvas, ctx, W, H;
let peerPositions = {};   // peer_hash → { x, y, angle, r }
let peerStates = {};      // peer_hash → { lit, delay }
let leafletMap = null;
let mapMarkers = [];

// ─── Boot ───────────────────────────────────────────────────────
window.addEventListener("load", async () => {
    canvas = document.getElementById("viz-canvas");
    ctx = canvas.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    await loadData();
    setupUI();
    drawIdle();
});

function resizeCanvas() {
    const container = document.querySelector(".panel-center");
    W = container.clientWidth;
    H = container.clientHeight;
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

// ─── Data Loading ───────────────────────────────────────────────
async function loadData() {
    const [peersData, wavefrontsData, messagesData, communitiesData, leaksData, summaryData] =
        await Promise.all([
            fetchJSON(`${DATA_BASE}/peers.json`),
            fetchJSON(`${DATA_BASE}/wavefronts.json`),
            fetchJSON(`${DATA_BASE}/messages.json`),
            fetchJSON(`${DATA_BASE}/communities.json`),
            fetchJSON(`${DATA_BASE}/leaks.json`),
            fetchJSON(`${DATA_BASE}/summary.json`),
        ]);

    peers = peersData;
    wavefronts = wavefrontsData;
    messages = messagesData;
    communities = communitiesData;
    leaks = leaksData;
    summary = summaryData;

    // Normalize messages: convert dict to array, enrich from wavefronts
    if (!Array.isArray(messages)) {
        messages = Object.entries(messages).map(([hash, m]) => {
            const wf = wavefronts[hash] || wavefronts[String(hash)] || {};
            return {
                hash,
                ...m,
                peer_count: wf.total_peers || (wf.arrivals ? wf.arrivals.length : 0),
                time_spread_ms: wf.spread_ms || 0,
            };
        });
    }

    // Update header stats
    document.getElementById("stat-peers").textContent = summary.total_peers || Object.keys(peers).length;
    document.getElementById("stat-msgs").textContent = summary.total_messages?.toLocaleString() || "—";
    document.getElementById("stat-ips").textContent = summary.peers_with_ip || "—";
    const leakCount = (leaks.first_responders?.length || 0) + (leaks.colocation?.length || 0);
    document.getElementById("stat-leaks").textContent = leakCount;

    computeLayout();
}

async function fetchJSON(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        console.warn(`Failed to load ${url}:`, e);
        return {};
    }
}

// ─── Layout Computation ─────────────────────────────────────────
function computeLayout() {
    // Group peers by community, then place each community in a sector
    const byCommunity = {};
    for (const [ph, p] of Object.entries(peers)) {
        const c = p.community || "unknown";
        if (!byCommunity[c]) byCommunity[c] = [];
        byCommunity[c].push(ph);
    }

    const communityKeys = Object.keys(byCommunity).sort();
    const totalPeers = Object.keys(peers).length;
    if (totalPeers === 0) return;

    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(W, H) * 0.42;

    let angleOffset = 0;
    for (const cKey of communityKeys) {
        const cPeers = byCommunity[cKey];
        const sectorAngle = (cPeers.length / totalPeers) * Math.PI * 2;

        for (let i = 0; i < cPeers.length; i++) {
            const ph = cPeers[i];
            const frac = cPeers.length > 1 ? i / (cPeers.length - 1) : 0.5;
            const angle = angleOffset + frac * sectorAngle;

            // Vary radius based on first-responder score (faster = closer to center)
            const peer = peers[ph];
            const avgPct = peer?.avg_arrival_pct ?? 0.5;
            const r = maxR * (0.2 + 0.8 * avgPct); // faster peers closer to center

            peerPositions[ph] = {
                x: cx + Math.cos(angle) * r,
                y: cy + Math.sin(angle) * r,
                angle,
                r,
            };
        }
        angleOffset += sectorAngle + 0.04; // small gap between communities
    }
}

// ─── UI Setup ───────────────────────────────────────────────────
function setupUI() {
    // Message filter buttons
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

    // View tabs
    document.querySelectorAll(".view-tabs button").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".view-tabs button").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            switchView(btn.dataset.view);
        });
    });

    // Tooltip on canvas
    canvas.addEventListener("mousemove", handleCanvasHover);
    canvas.addEventListener("mouseleave", () => {
        document.getElementById("tooltip").style.display = "none";
    });

    // Render messages, communities, leaks
    renderMessageList("all");
    renderCommunities();
    renderLeaks();

    // Auto-select first message
    if (messages.length > 0) {
        selectMessage(messages[0]);
    }
}

function renderMessageList(filterType) {
    const list = document.getElementById("msg-list");
    list.innerHTML = "";

    const filtered = filterType === "all"
        ? messages
        : messages.filter(m => m.type === filterType);

    // Sort by peer_count descending
    const sorted = [...filtered].sort((a, b) => b.peer_count - a.peer_count);
    const display = sorted.slice(0, 100); // show top 100

    for (const msg of display) {
        const el = document.createElement("div");
        el.className = "msg-item" + (currentMsg && currentMsg.hash === msg.hash ? " active" : "");

        const typeShort = msg.type === "channel_announcement" ? "chan_ann"
            : msg.type === "node_announcement" ? "node_ann" : "chan_upd";

        el.innerHTML = `
            <span class="type-badge type-${typeShort}">${typeShort}</span>
            <span class="peers-count">${msg.peer_count} peers · ${(msg.time_spread_ms / 1000).toFixed(1)}s</span>
        `;
        el.addEventListener("click", () => selectMessage(msg));
        list.appendChild(el);
    }
}

function renderCommunities() {
    const el = document.getElementById("community-legend");
    el.innerHTML = "";

    // Count peers per community
    const counts = {};
    for (const p of Object.values(peers)) {
        const c = p.community || "unknown";
        counts[c] = (counts[c] || 0) + 1;
    }

    // If communities is an object with community info
    const comms = Array.isArray(communities) ? communities
        : Object.entries(communities).map(([k, v]) => ({ id: k, ...v }));

    for (const c of comms) {
        const cid = c.id || c.label;
        const item = document.createElement("div");
        item.className = "community-item";
        item.innerHTML = `
            <div class="community-dot" style="background:${c.color || '#666'}"></div>
            <span>${c.label || c.id || "Unknown"} (${counts[cid] || "?"})</span>
        `;
        el.appendChild(item);
    }
}

function renderLeaks() {
    // First responders
    const frContainer = document.getElementById("leak-first-responders");
    const frList = leaks.first_responders || [];
    for (const fr of frList) {
        const card = document.createElement("div");
        card.className = "leak-card critical";
        const peerKey = fr.pubkey || fr.peer_hash;
        const peer = peers[peerKey] || {};
        card.innerHTML = `
            <div class="label">🔍 Surveillance Suspect</div>
            <div class="detail">
                <strong>${fr.alias || peer.alias || "Unknown"}</strong><br>
                ${fr.ip ? `<span class="ip-info">IP: ${fr.ip}</span><br>` : ""}
                Top-5 arrival in <strong>${((fr.top5_pct || 0) * 100).toFixed(1)}%</strong> of messages<br>
                First arrival: <strong>${((fr.first_pct || 0) * 100).toFixed(1)}%</strong> of the time<br>
                Seen <strong>${(fr.messages_seen || 0).toLocaleString()}</strong> messages
                <div class="metric">avg arrival: ${((fr.avg_arrival_pct || 0) * 100).toFixed(1)}th percentile</div>
            </div>
        `;
        frContainer.appendChild(card);
    }

    // Co-location
    const clContainer = document.getElementById("leak-colocation");
    const clList = leaks.colocation || leaks.colocation_suspects || [];
    for (const cl of clList) {
        const card = document.createElement("div");
        card.className = "leak-card";
        const peerList = cl.peers || [];
        const peerAliases = peerList
            .map(ph => peers[ph]?.alias || ph.toString().slice(0, 12) + "…")
            .join(", ");
        card.innerHTML = `
            <div class="label">📍 Co-located Peers</div>
            <div class="detail">
                Subnet: <strong>${cl.prefix || cl.subnet || "?"}</strong><br>
                ${cl.count || peerList.length} peers: ${peerAliases}
                <div class="metric">${cl.count || peerList.length} nodes, same /24</div>
            </div>
        `;
        clContainer.appendChild(card);
    }
}

// ─── Message Selection & Animation ──────────────────────────────
function selectMessage(msg) {
    currentMsg = msg;

    // Build wavefront key — try string hash or numeric
    const wfData = wavefronts[msg.hash] || wavefronts[String(msg.hash)] || {};
    // wavefront can be { arrivals: [...], total_peers, spread_ms } or just an array
    currentWavefront = Array.isArray(wfData) ? wfData : (wfData.arrivals || []);

    // Reset peer states
    peerStates = {};
    for (const ph of Object.keys(peers)) {
        peerStates[ph] = { lit: false, delay: Infinity };
    }
    for (const entry of currentWavefront) {
        const ph = entry.peer || entry.peer_hash;
        if (peerStates[ph] !== undefined) {
            peerStates[ph].delay = entry.delay_ms;
        }
    }

    // Highlight active in list
    document.querySelectorAll(".msg-item").forEach(el => el.classList.remove("active"));
    // Re-render to show active state
    resetAnim();
    drawFrame(0);
    updateMapForMessage();
}

function togglePlay() {
    if (animPlaying) {
        animPlaying = false;
        cancelAnimationFrame(animFrame);
        document.getElementById("btn-play").textContent = "▶ Play";
    } else {
        animPlaying = true;
        animStart = performance.now();
        document.getElementById("btn-play").textContent = "⏸ Pause";
        animLoop();
    }
}

function resetAnim() {
    animPlaying = false;
    animStart = null;
    cancelAnimationFrame(animFrame);
    document.getElementById("btn-play").textContent = "▶ Play";
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("time-display").textContent = "0.000s";
    drawFrame(0);
}

function animLoop() {
    if (!animPlaying) return;

    const elapsed = (performance.now() - animStart) * animSpeed;
    const maxDelay = currentMsg?.time_spread_ms || 5000;

    if (elapsed > maxDelay + 500) {
        animPlaying = false;
        document.getElementById("btn-play").textContent = "▶ Play";
        drawFrame(maxDelay);
        document.getElementById("progress-fill").style.width = "100%";
        return;
    }

    drawFrame(elapsed);

    const progress = Math.min(100, (elapsed / maxDelay) * 100);
    document.getElementById("progress-fill").style.width = progress + "%";
    document.getElementById("time-display").textContent = (elapsed / 1000).toFixed(3) + "s";

    animFrame = requestAnimationFrame(animLoop);
}

// ─── Canvas Drawing ─────────────────────────────────────────────
function drawIdle() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#333";
    ctx.font = "14px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Loading data...", W / 2, H / 2);
}

function drawFrame(elapsedMs) {
    if (currentView !== "radial") return;

    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;

    // Draw concentric rings
    const maxR = Math.min(W, H) * 0.42;
    for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * (i / 4), 0, Math.PI * 2);
        ctx.strokeStyle = "#1a1a2e";
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // Draw observer at center
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6b35";
    ctx.fill();
    ctx.font = "9px monospace";
    ctx.fillStyle = "#ff6b3580";
    ctx.textAlign = "center";
    ctx.fillText("OBSERVER", cx, cy + 15);

    // Draw expanding wavefront ring
    if (currentWavefront && currentWavefront.length > 0) {
        const maxDelay = currentMsg?.time_spread_ms || 5000;
        const waveFrac = Math.min(1, elapsedMs / maxDelay);
        const waveR = waveFrac * maxR;

        ctx.beginPath();
        ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 107, 53, ${0.3 * (1 - waveFrac)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Draw peers
    for (const [ph, pos] of Object.entries(peerPositions)) {
        const state = peerStates[ph];
        const peer = peers[ph];
        if (!pos) continue;

        const isLit = state && state.delay <= elapsedMs;
        const communityColor = getCommunityColor(peer?.community);

        if (isLit) {
            // Lit peer — bright colored dot
            const freshness = Math.max(0, 1 - (elapsedMs - state.delay) / 2000);
            const glow = freshness * 8;

            if (glow > 0) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 3 + glow, 0, Math.PI * 2);
                ctx.fillStyle = communityColor + "30";
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = communityColor;
            ctx.fill();

            // Line from center to peer (subtle)
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(pos.x, pos.y);
            ctx.strokeStyle = communityColor + "15";
            ctx.lineWidth = 0.5;
            ctx.stroke();
        } else {
            // Unlit peer — dim
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
            ctx.fillStyle = "#2a2a3e";
            ctx.fill();
        }
    }

    // Draw labels for first-responder suspects
    if (leaks.first_responders) {
        for (const fr of leaks.first_responders) {
            const ph = fr.pubkey || fr.peer_hash;
            const pos = peerPositions[ph];
            const state = peerStates[ph];
            if (!pos || !state || state.delay > elapsedMs) continue;

            const peer = peers[ph];
            ctx.font = "8px monospace";
            ctx.fillStyle = "#e63946cc";
            ctx.textAlign = "left";
            const label = fr.alias || peer?.alias || ph.toString().slice(0, 8);
            ctx.fillText("⚠ " + label, pos.x + 6, pos.y + 3);
        }
    }
}

function getCommunityColor(communityId) {
    if (!communityId) return "#888";

    // Check communities data
    const c = communities[communityId];
    if (c && c.color) return c.color;

    // Fallback palette
    const palette = [
        "#ff6b35", "#2a9d8f", "#e9c46a", "#457b9d", "#e63946",
        "#a855f7", "#06d6a0", "#ef476f", "#118ab2", "#ffd166",
    ];
    // Hash community id to pick a color
    let hash = 0;
    const s = String(communityId);
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
}

// ─── Canvas Hover / Tooltip ─────────────────────────────────────
function handleCanvasHover(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closest = null;
    let closestDist = 20; // px threshold

    for (const [ph, pos] of Object.entries(peerPositions)) {
        const dx = pos.x - mx;
        const dy = pos.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist) {
            closest = ph;
            closestDist = dist;
        }
    }

    const tooltip = document.getElementById("tooltip");

    if (closest) {
        const peer = peers[closest] || {};
        const state = peerStates[closest] || {};
        const isSuspect = leaks.first_responders?.some(fr => (fr.pubkey || fr.peer_hash) === closest);

        tooltip.innerHTML = `
            <div class="alias">${peer.alias || "Unknown"} ${isSuspect ? "⚠️" : ""}</div>
            <div class="pubkey">${closest}</div>
            ${peer.ip ? `<div class="ip-info">🌐 ${peer.ip}</div>` : '<div style="color:#666">🧅 Tor-only</div>'}
            ${peer.community ? `<div style="margin-top:4px;color:${getCommunityColor(peer.community)}">● ${peer.community}</div>` : ""}
            <div class="score-info">
                Avg arrival: ${((peer.avg_arrival_pct || 0) * 100).toFixed(1)}th pct<br>
                ${state.delay < Infinity ? `This msg: +${state.delay.toFixed(0)}ms` : "Not seen"}
            </div>
        `;
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX + 12) + "px";
        tooltip.style.top = (e.clientY - 10) + "px";
    } else {
        tooltip.style.display = "none";
    }
}

// ─── Map View ───────────────────────────────────────────────────
function switchView(view) {
    currentView = view;
    const mapEl = document.getElementById("map-container");

    if (view === "map") {
        canvas.style.display = "none";
        mapEl.style.display = "block";
        initMap();
        updateMapForMessage();
    } else {
        canvas.style.display = "block";
        mapEl.style.display = "none";
        resizeCanvas();
        computeLayout();
        if (currentMsg) drawFrame(0);
        else drawIdle();
    }
}

function initMap() {
    if (leafletMap) return;

    leafletMap = L.map("map-container", {
        center: [20, 0],
        zoom: 2,
        zoomControl: true,
        attributionControl: false,
    });

    // Dark tile layer
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
    }).addTo(leafletMap);

    // Invalidate size after a tick (container may not be visible yet)
    setTimeout(() => leafletMap.invalidateSize(), 100);
}

function updateMapForMessage() {
    if (!leafletMap) return;

    // Clear old markers
    for (const m of mapMarkers) leafletMap.removeLayer(m);
    mapMarkers = [];

    if (!currentWavefront || currentWavefront.length === 0) return;

    const maxDelay = currentMsg?.time_spread_ms || 5000;

    for (const entry of currentWavefront) {
        const ph = entry.peer || entry.peer_hash;
        const peer = peers[ph];
        if (!peer || !peer.lat || !peer.lon) continue;

        // Color by arrival time: early = red/hot, late = blue/cool
        const frac = Math.min(1, entry.delay_ms / maxDelay);
        const color = lerpColor("#ff6b35", "#457b9d", frac);

        const marker = L.circleMarker([peer.lat, peer.lon], {
            radius: 5,
            fillColor: color,
            color: color,
            fillOpacity: 0.8,
            weight: 1,
        });

        marker.bindTooltip(
            `<b>${peer.alias || "?"}</b><br>+${entry.delay_ms.toFixed(0)}ms<br>${peer.ip || "tor"}`,
            { className: "dark-tooltip" }
        );

        marker.addTo(leafletMap);
        mapMarkers.push(marker);
    }
}

function lerpColor(a, b, t) {
    const ah = parseInt(a.slice(1), 16);
    const bh = parseInt(b.slice(1), 16);
    const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `#${((rr << 16) | (rg << 8) | rb).toString(16).padStart(6, "0")}`;
}
