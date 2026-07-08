let currentStatusFilter = "";

// Live, mutable state for every PC — built once from the table, then drifted over time
// to simulate a real-time monitoring feed.
let pcRegistry = [];
let activeModalPcId = null;
let liveTickInterval = null;

// Fleet-wide aggregate history (avg CPU temp / avg storage %) for the
// "Fleet Live Overview" panel at the top of the page.
let fleetHistory = [];

document.addEventListener("DOMContentLoaded", () => {
    initThemeToggle();
    initMetricCardListeners();
    setupInputFilters();
    initModalControls();
    buildPcRegistry();
    recordFleetHistory();
    ensureFleetOverviewSection();
    renderAnalyticsDashboard();
    renderFleetOverview();
    startLiveTicking();
});

/**
 * Global Filtering Ingestion Controls
 */
function setupInputFilters() {
    const searchInput = document.getElementById("searchInput");
    const branchFilter = document.getElementById("branchFilter");

    if (searchInput) searchInput.addEventListener("input", renderAnalyticsDashboard);
    if (branchFilter) branchFilter.addEventListener("change", renderAnalyticsDashboard);
}

/**
 * Metric Card State & Interaction Modifiers
 */
function initMetricCardListeners() {
    const cardMap = {
        'card-all': '',
        'card-healthy': 'healthy',
        'card-warning': 'warning',
        'card-critical': 'critical'
    };

    Object.keys(cardMap).forEach(cardId => {
        const cardElement = document.getElementById(cardId);
        if (cardElement) {
            cardElement.addEventListener('click', () => {
                const targetStatus = cardMap[cardId];
                currentStatusFilter = (currentStatusFilter === targetStatus && targetStatus !== '') ? '' : targetStatus;
                updateCardSelectionStyles(cardId);
                renderAnalyticsDashboard();
            });
        }
    });
}

function updateCardSelectionStyles(activeCardId) {
    const cardIds = ['card-all', 'card-healthy', 'card-warning', 'card-critical'];
    cardIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;

        if (id === activeCardId && currentStatusFilter !== '') {
            el.style.border = "1px solid var(--color-text)";
            el.style.background = "var(--color-surface-hover)";
            el.style.transform = "translateY(-2px)";
        } else {
            el.style.border = "1px solid var(--color-border)";
            el.style.background = "var(--color-surface)";
            el.style.transform = "none";
        }
    });
}

/**
 * ==========================================================================
 * LIVE DATA ENGINE — builds the mutable PC registry from the static table,
 * then continuously drifts values to simulate a real-time sensor feed.
 * ==========================================================================
 */
function buildPcRegistry() {
    const tableRows = document.querySelectorAll("#monitorTable tbody tr");
    pcRegistry = [];

    tableRows.forEach(row => {
        const cells = row.cells;
        if (cells.length < 12) return;

        const branch = cells[0].innerText.trim();
        const pcId = cells[1].innerText.trim();
        const user = cells[2].innerText.trim();
        const capacity = parseFloat(cells[4].innerText) || 1;
        const used = parseFloat(cells[5].innerText) || 0;
        const sectorStatus = cells[7].innerText.trim();
        const cpuTemp = parseFloat(cells[8].innerText) || 40;
        const boardTemp = parseFloat(cells[9].innerText) || 35;
        const keyboard = cells[10].innerText.trim();

        const pc = { branch, pcId, user, capacity, used, sectorStatus, keyboard, cpuTemp, boardTemp };
        recomputeDerivedFields(pc);

        // Seed the live sensor history buffer used by the gauge/chart dashboard.
        pc.history = [{ cpu: pc.cpuTemp, board: pc.boardTemp, storage: pc.computedStoragePercent }];

        // Live event log — populated as status/network transitions happen during ticks.
        pc.eventLog = [];

        pcRegistry.push(pc);
    });
}

/**
 * Recalculates everything that depends on the raw sensor numbers:
 * free space, storage %, network state, and overall severity status.
 */
function recomputeDerivedFields(pc) {
    pc.free = Math.max(0, pc.capacity - pc.used);
    pc.computedStoragePercent = Math.round((pc.used / pc.capacity) * 100) || 0;
    pc.numCpu = pc.cpuTemp;

    let networkStatus = "Online";
    if (pc.cpuTemp >= 88) networkStatus = "Offline";
    else if (pc.cpuTemp >= 65 || pc.keyboard.toLowerCase() === "malfunction") networkStatus = "High Latency";
    pc.networkStatus = networkStatus;

    const lowerSector = pc.sectorStatus.toLowerCase();
    const sectorIsBad = lowerSector.includes("degradation") || lowerSector.includes("bad blocks") || lowerSector.includes("critical");

    let status = "healthy";
    if (pc.cpuTemp >= 85 || pc.computedStoragePercent >= 95 || sectorIsBad || pc.keyboard.toLowerCase() === "malfunction" || pc.networkStatus === "Offline") {
        status = "critical";
    } else if (pc.cpuTemp >= 55 || pc.computedStoragePercent >= 90 || pc.networkStatus === "High Latency" || lowerSector.includes("near full")) {
        status = "warning";
    }
    pc.status = status;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * ==========================================================================
 * LIVE DASHBOARD VISUAL ENGINE — SVG gauges + history sparkline chart
 * used inside the "View Live Diagnostics" modal. No chart library required.
 * ==========================================================================
 */

// Standard polar->cartesian helper for drawing circular/semicircular SVG arcs.
function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
    return {
        x: centerX + (radius * Math.cos(angleInRadians)),
        y: centerY + (radius * Math.sin(angleInRadians))
    };
}

function describeArc(x, y, radius, startAngle, endAngle) {
    const start = polarToCartesian(x, y, radius, endAngle);
    const end = polarToCartesian(x, y, radius, startAngle);
    const largeArcFlag = (endAngle - startAngle) <= 180 ? "0" : "1";
    return ["M", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(" ");
}

/**
 * Renders a semicircle "speedometer" style gauge (like the Heap Usage / GC Count
 * panels in Grafana-style dashboards). Returns an inline SVG string.
 */
function buildGaugeSvg(value, max, color, valueText, unitLabel) {
    const cx = 80, cy = 82, r = 60, sw = 14;
    const safeValue = clamp(value, 0, max);
    const pct = max > 0 ? safeValue / max : 0;
    const valueAngle = -90 + (pct * 180);

    const trackPath = describeArc(cx, cy, r, -90, 90);
    const valuePath = describeArc(cx, cy, r, -90, valueAngle);

    return `
    <svg viewBox="0 0 160 100" style="width:100%; max-width:170px; display:block;">
        <path d="${trackPath}" fill="none" stroke="var(--color-border)" stroke-width="${sw}" stroke-linecap="round" opacity="0.7"/>
        ${pct > 0 ? `<path d="${valuePath}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>` : ""}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="24" font-weight="700" fill="var(--color-text)">${valueText}</text>
        ${unitLabel ? `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="var(--color-text-secondary)" letter-spacing="0.05em">${unitLabel}</text>` : ""}
    </svg>`;
}

/**
 * Renders a multi-series FILLED AREA history chart, mirroring the
 * Grafana-style "Heap Usage" gradient-fill panel look: translucent gradient
 * fills under each line, overlapping where series cross, plus a faint grid.
 *
 * @param {Array} history     Array of data points, e.g. [{cpu: 42, board: 35}, ...]
 * @param {Array} seriesConfig  [{ key: 'cpu', color: '#d4a72c' }, ...] — which
 *                               fields of each history point to plot, and in what color.
 * @param {string} idPrefix    Unique prefix for SVG gradient ids (multiple charts
 *                               can be on screen at once — e.g. fleet chart + modal chart).
 * @param {number} maxVal      Scale ceiling for the y-axis (default 100).
 */
function buildHistoryChartSvg(history, seriesConfig, idPrefix, maxVal) {
    maxVal = maxVal || 100;

    if (!history || history.length < 2) {
        return `<div style="height:150px; display:flex; align-items:center; justify-content:center; color:var(--color-text-muted); font-size:12px;">Gathering telemetry…</div>`;
    }

    const w = 600, h = 150, pad = 10;
    const baseY = h - pad;
    const stepX = (w - pad * 2) / (history.length - 1);

    function coordsFor(key) {
        return history.map((pt, i) => {
            const x = pad + (i * stepX);
            const y = pad + (1 - clamp(pt[key] || 0, 0, maxVal) / maxVal) * (h - pad * 2);
            return { x: +x.toFixed(1), y: +y.toFixed(1) };
        });
    }

    function lineFrom(points) {
        return points.map(p => `${p.x},${p.y}`).join(" ");
    }

    function areaFrom(points) {
        const first = points[0], last = points[points.length - 1];
        return `M ${first.x},${baseY} ` + points.map(p => `L ${p.x},${p.y}`).join(" ") + ` L ${last.x},${baseY} Z`;
    }

    // Faint grid (mimics the reference image's gridlines)
    let gridLines = "";
    for (let i = 1; i <= 3; i++) {
        const gy = pad + (i * (h - pad * 2) / 4);
        gridLines += `<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${w - pad}" y2="${gy.toFixed(1)}" stroke="var(--color-border)" stroke-width="1" opacity="0.5"/>`;
    }
    for (let i = 1; i <= 5; i++) {
        const gx = pad + (i * (w - pad * 2) / 6);
        gridLines += `<line x1="${gx.toFixed(1)}" y1="${pad}" x2="${gx.toFixed(1)}" y2="${baseY}" stroke="var(--color-border)" stroke-width="1" opacity="0.3"/>`;
    }

    const gradDefs = seriesConfig.map((s, idx) => `
        <linearGradient id="${idPrefix}-grad-${idx}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${s.color}" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="${s.color}" stop-opacity="0.05"/>
        </linearGradient>
    `).join("");

    const seriesPoints = seriesConfig.map(s => coordsFor(s.key));
    const areaPaths = seriesConfig.map((s, idx) => `<path d="${areaFrom(seriesPoints[idx])}" fill="url(#${idPrefix}-grad-${idx})" stroke="none"/>`).join("");
    const linePaths = seriesConfig.map((s, idx) => `<polyline points="${lineFrom(seriesPoints[idx])}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("");

    return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%; height:150px; display:block;">
        <defs>${gradDefs}</defs>

        <line x1="${pad}" y1="${baseY}" x2="${w - pad}" y2="${baseY}" stroke="var(--color-border)" stroke-width="1"/>
        ${gridLines}

        ${areaPaths}
        ${linePaths}
    </svg>`;
}

/**
 * One simulated "tick" of the live feed — nudges every PC's sensor readings
 * a little, recalculates status, records history + events, then refreshes
 * whatever is on screen.
 */
function tickLiveData() {
    pcRegistry.forEach(pc => {
        const prevStatus = pc.status;
        const prevNetworkStatus = pc.networkStatus;

        const cpuDelta = (Math.random() * 3) - 1.4;
        pc.cpuTemp = clamp(pc.cpuTemp + cpuDelta, 28, 97);

        const boardDelta = ((Math.random() * 2) - 1) + ((pc.cpuTemp - pc.boardTemp) * 0.05);
        pc.boardTemp = clamp(pc.boardTemp + boardDelta, 24, 80);

        if (Math.random() < 0.05) {
            pc.used = clamp(pc.used - (pc.capacity * 0.01), 0, pc.capacity);
        } else {
            pc.used = clamp(pc.used + (pc.capacity * (Math.random() * 0.0015)), 0, pc.capacity);
        }

        recomputeDerivedFields(pc);

        pc.history.push({ cpu: pc.cpuTemp, board: pc.boardTemp, storage: pc.computedStoragePercent });
        if (pc.history.length > 30) pc.history.shift();

        logPcEventsIfChanged(pc, prevStatus, prevNetworkStatus);
    });

    recordFleetHistory();
    renderAnalyticsDashboard();
    renderFleetOverview();
    refreshModalIfOpen();
}

/**
 * ==========================================================================
 * LIVE EVENT LOG — detects meaningful state transitions on each tick and
 * appends a human-readable entry to that PC's event log (shown in the modal).
 * ==========================================================================
 */
function pushPcEvent(pc, message, severity) {
    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    pc.eventLog.unshift({ time: timestamp, message, severity });
    if (pc.eventLog.length > 20) pc.eventLog.length = 20;
}

function logPcEventsIfChanged(pc, prevStatus, prevNetworkStatus) {
    if (pc.status !== prevStatus) {
        const severityRank = { healthy: 0, warning: 1, critical: 2 };
        const improved = severityRank[pc.status] < severityRank[prevStatus];
        const verb = improved ? "Recovered" : "Escalated";
        pushPcEvent(pc, `${verb}: ${prevStatus.toUpperCase()} → ${pc.status.toUpperCase()}`, pc.status);
    }

    if (pc.networkStatus !== prevNetworkStatus) {
        let netSeverity = "healthy";
        if (pc.networkStatus === "Offline") netSeverity = "critical";
        else if (pc.networkStatus === "High Latency") netSeverity = "warning";
        pushPcEvent(pc, `Network link changed: ${prevNetworkStatus} → ${pc.networkStatus}`, netSeverity);
    }
}

function severityColor(severity) {
    if (severity === "critical") return "var(--color-error)";
    if (severity === "warning") return "var(--color-warning)";
    return "var(--color-success)";
}

/**
 * ==========================================================================
 * FLEET LIVE OVERVIEW — aggregate gauges + trend chart across every device,
 * rendered as a new panel inserted right under the top stat cards.
 * ==========================================================================
 */
function recordFleetHistory() {
    if (pcRegistry.length === 0) return;
    const total = pcRegistry.length;
    const avgCpu = pcRegistry.reduce((sum, pc) => sum + pc.cpuTemp, 0) / total;
    const avgStorage = pcRegistry.reduce((sum, pc) => sum + pc.computedStoragePercent, 0) / total;

    fleetHistory.push({ cpu: avgCpu, storage: avgStorage });
    if (fleetHistory.length > 30) fleetHistory.shift();
}

function ensureFleetOverviewSection() {
    if (document.getElementById("fleetOverviewSection")) return;
    const statsGrid = document.querySelector(".stats-grid");
    if (!statsGrid) return;

    const section = document.createElement("div");
    section.id = "fleetOverviewSection";
    section.className = "fleet-overview-card";
    statsGrid.insertAdjacentElement("afterend", section);
}

function renderFleetOverview() {
    const section = document.getElementById("fleetOverviewSection");
    if (!section || pcRegistry.length === 0) return;

    const total = pcRegistry.length;
    const healthyCount = pcRegistry.filter(p => p.status === "healthy").length;
    const avgCpu = pcRegistry.reduce((sum, pc) => sum + pc.cpuTemp, 0) / total;
    const avgStorage = pcRegistry.reduce((sum, pc) => sum + pc.computedStoragePercent, 0) / total;
    const healthyPct = Math.round((healthyCount / total) * 100);

    const cpuColor = avgCpu >= 80 ? "var(--color-error)" : (avgCpu >= 50 ? "var(--color-warning)" : "var(--color-success)");
    const storageColor = avgStorage >= 90 ? "var(--color-error)" : (avgStorage >= 75 ? "var(--color-warning)" : "var(--color-success)");
    const healthColor = healthyPct >= 90 ? "var(--color-success)" : (healthyPct >= 70 ? "var(--color-warning)" : "var(--color-error)");

    section.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-md); flex-wrap: wrap; gap: var(--space-sm);">
            <h2 style="font-size: var(--text-base); margin:0; color: var(--color-text);">Fleet Live Overview</h2>
            <div class="live-pulse-indicator" style="margin:0;"><span class="live-dot"></span>Live — all ${total} devices</div>
        </div>
        <div class="gauge-row">
            <div class="gauge-panel">
                <span class="gauge-panel-title">Avg CPU Temp</span>
                ${buildGaugeSvg(avgCpu, 100, cpuColor, Math.round(avgCpu), "°C")}
            </div>
            <div class="gauge-panel">
                <span class="gauge-panel-title">Avg Storage Used</span>
                ${buildGaugeSvg(avgStorage, 100, storageColor, Math.round(avgStorage), "%")}
            </div>
            <div class="gauge-panel">
                <span class="gauge-panel-title">Fleet Healthy</span>
                ${buildGaugeSvg(healthyPct, 100, healthColor, healthyPct, "%")}
            </div>
        </div>
        <div class="chart-panel" style="margin-bottom:0;">
            <div class="chart-panel-title">Fleet Usage History</div>
            ${buildHistoryChartSvg(fleetHistory, [{ key: "cpu", color: "#d4a72c" }, { key: "storage", color: "#3b82f6" }], "fleet")}
            <div class="chart-legend">
                <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#d4a72c;"></span>Avg CPU Temp</span>
                <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#3b82f6;"></span>Avg Storage Used</span>
            </div>
        </div>
    `;
}

function startLiveTicking() {
    if (liveTickInterval) clearInterval(liveTickInterval);
    liveTickInterval = setInterval(tickLiveData, 2500);
}

/**
 * Actionable Prevention Advisor Engine
 * Generates direct user procedures to mitigate hardware faults before they cause system downtime.
 */
function getSystemPreventionAdvisoryHtml(pc) {
    if (pc.status === "healthy") return "";

    let issues = [];
    const isWarning = pc.status === "warning";
    const bannerClass = isWarning ? "banner-warning" : "banner-error";
    const titleColor = isWarning ? "var(--color-warning)" : "var(--color-error)";
    const cpuTempLabel = `${Math.round(pc.cpuTemp)}°C`;

    // 1. STORAGE CONTINGENCY ENGINE
    if (pc.computedStoragePercent >= 95) {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-error); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">storage</span> 
                    CRITICAL DROP RISK: DRIVE CAPACITY ALMOST FULL (${pc.computedStoragePercent}% Used)
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-error);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Immediately delete temporary runtime directories (type <code>%temp%</code> in Windows Run) and run built-in OS Disk Cleanup. Backup and move critical business databases to external servers right away to prevent system crashes.</div>
                    <div><b>How to prevent it:</b> Enable automatic Storage Sense features to purge trash bins daily, or schedule a physical upgrade to a larger 1TB SSD array.</div>
                </div>
            </div>
        `);
    } else if (pc.computedStoragePercent >= 90) {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-warning); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">running_with_errors</span> 
                    WARNING: STORAGE SPACE RUNNING OUT (${pc.computedStoragePercent}% Used)
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-warning);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Open your file directory and review your downloads folder. Clear out or compress historical document archives, media files, and redundant software installers.</div>
                    <div><b>How to prevent it:</b> Enforce strict company data policies—routinely offload weekly transaction logs onto localized NAS networks instead of letting them pile up on local desktops.</div>
                </div>
            </div>
        `);
    }

    // 2. STORAGE HEALTH INTEGRITY ENGINE
    const lowerSector = pc.sectorStatus.toLowerCase();
    if (lowerSector.includes("degradation") || lowerSector.includes("bad blocks")) {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-error); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">heart_broken</span> 
                    CRITICAL HARDWARE FAULT: HARD DRIVE SECTOR DEGRADATION (${pc.sectorStatus})
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-error);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Immediately stop saving new files to this unit. Run a localized data mirroring tool or copy your workspace files directly onto a secure USB drive or network share.</div>
                    <div><b>How to prevent it:</b> This drive is physically wearing out. Schedule an administrative technical work order to swap this failing drive with a fresh SSD before structural data corruption strikes.</div>
                </div>
            </div>
        `);
    }

    // 3. THERMAL EXCEPTION ENGINE
    if (pc.numCpu >= 80) {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-error); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">device_thermostat</span> 
                    CRITICAL HARDWARE FAULT: CPU OVERHEATING (${cpuTempLabel})
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-error);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Close any frozen system processes or complex background applications immediately to let the processor cool down. If the temperature doesn't drop beneath 70°C inside 5 minutes, turn off the computer to save it from permanent damage.</div>
                    <div><b>How to prevent it:</b> Check that the PC is elevated and its vents aren't blocked by walls or desks. Blow out trapped dust using compressed air and consider reapplying thermal paste to the CPU core block.</div>
                </div>
            </div>
        `);
    } else if (pc.numCpu >= 50 && isWarning) {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-warning); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">thermostat</span> 
                    WARNING: ELEVATED TEMPERATURE DETECTED (${cpuTempLabel})
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-warning);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Audit your active web browser tabs and drop demanding tasks. Avoid keeping multiple resource-heavy programs open at the same time.</div>
                </div>
            </div>
        `);
    }

    // 4. NETWORK LINK DROPS ENGINE
    if (pc.networkStatus === "Offline") {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-error); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">wifi_off</span> 
                    CRITICAL COMMUNICATION FAULT: NETWORK CONNECTION OFFLINE
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-error);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Verify the physical Ethernet patch cord is securely clicked into the PC backpanel and branch wall switch. Power cycle the localized office router if adjacent devices are dropping too.</div>
                    <div><b>How to prevent it:</b> Inspect network line cables for physical damage and update network adapter drivers to prevent random drops.</div>
                </div>
            </div>
        `);
    } else if (pc.networkStatus === "High Latency") {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-warning); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">signal_cellular_connected_no_internet_4_bar</span> 
                    WARNING: NETWORK BANDWIDTH CONGESTION (High Latency)
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-warning);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Halt unapproved network streams, large downloads, or hidden cloud syncs happening during busy operation hours.</div>
                </div>
            </div>
        `);
    }

    // 5. PERIPHERAL INPUT MALFUNCTION ENGINE
    if (pc.keyboard.toLowerCase() === "malfunction") {
        issues.push(`
            <div style="margin-bottom: var(--space-sm);">
                <b style="color: var(--color-error); display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">keyboard</span> 
                    CRITICAL HARDWARE FAULT: KEYBOARD PERIPHERAL MALFUNCTION
                </b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-error);">
                    <div style="margin-bottom: 2px;"><b>How to fix now:</b> Unplug the device interface cable and insert it into an alternate USB bus hub port (preferably a native rear motherboard port instead of front chassis extensions).</div>
                    <div><b>How to prevent it:</b> Open Windows Device Manager, find your USB Universal Serial Bus Controllers, uninstall the faulty device node, and reboot the station to force a clean system driver reinstall.</div>
                </div>
            </div>
        `);
    }

    // Fallback block if generic failure catch occurs
    if (issues.length === 0) {
        issues.push(`
            <div>
                <b>⚠️ UNCLASSIFIED REGISTER EXCEPTION OPERATIONAL WARN:</b>
                <div style="margin: var(--space-xs) 0 0 4px; padding-left: 12px; border-left: 2px solid var(--color-warning);">
                    <div><b>Action:</b> Perform a soft machine restart to clear memory caches. Contact system IT administrators if telemetry warnings continue to signal.</div>
                </div>
            </div>
        `);
    }

    return `
        <div class="diagnostic-prevention-banner ${bannerClass}">
            <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: ${titleColor}; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.02em;">
                <span class="material-symbols-rounded" style="font-size: 18px;">gpp_maybe</span>
                Action Required // Preventative Maintenance Instructions
            </div>
            <div style="color: var(--color-text-secondary); display:flex; flex-direction:column; font-size:12px;">
                ${issues.join("")}
            </div>
        </div>
    `;
}

/**
 * Main Template Aggregation and Matrix Calculation Engine
 * Renders branch groups -> compact PC cards. Clicking a card opens the live detail modal.
 */
function renderAnalyticsDashboard() {
    const container = document.getElementById("analyticsGraphsContainer");
    const filterBadgeEl = document.getElementById("activeFilterBadge");

    const searchInputEl = document.getElementById("searchInput");
    const branchFilterEl = document.getElementById("branchFilter");

    const searchFilter = searchInputEl ? searchInputEl.value.toLowerCase().trim() : "";
    const activeBranchFilter = branchFilterEl ? branchFilterEl.value.trim() : "";

    if (!container) return;

    // Retain accordion expansion context states between pipeline filters / live ticks
    const expandedBranches = Array.from(document.querySelectorAll('.branch-analytics-card.is-expanded'))
        .map(el => el.getAttribute('data-branch-name'));

    let branchDataMap = {};
    let globalTotal = 0, globalHealthy = 0, globalWarning = 0, globalCritical = 0;

    pcRegistry.forEach(pc => {
        globalTotal++;
        if (pc.status === "healthy") globalHealthy++;
        else if (pc.status === "warning") globalWarning++;
        else if (pc.status === "critical") globalCritical++;

        const matchSearch = pc.pcId.toLowerCase().includes(searchFilter) || pc.user.toLowerCase().includes(searchFilter);
        const matchBranch = activeBranchFilter === "" || pc.branch === activeBranchFilter;
        const matchStatusClick = currentStatusFilter === "" || pc.status === currentStatusFilter;

        if (!matchSearch || !matchBranch || !matchStatusClick) return;

        if (!branchDataMap[pc.branch]) branchDataMap[pc.branch] = [];
        branchDataMap[pc.branch].push(pc);
    });

    // Write Computed System Summaries to DOM Modifiers
    if (document.getElementById("totalPCs")) document.getElementById("totalPCs").innerText = globalTotal;
    if (document.getElementById("healthyCount")) document.getElementById("healthyCount").innerText = globalHealthy;
    if (document.getElementById("warningCount")) document.getElementById("warningCount").innerText = globalWarning;
    if (document.getElementById("criticalCount")) document.getElementById("criticalCount").innerText = globalCritical;

    if (filterBadgeEl) {
        if (currentStatusFilter !== "") {
            filterBadgeEl.innerHTML = `<span class="material-symbols-rounded" style="font-size:14px; color:var(--color-primary);">filter_list</span> Filter Active: <b>${currentStatusFilter.toUpperCase()}</b> systems displayed.`;
        } else {
            filterBadgeEl.innerHTML = `<span class="material-symbols-rounded" style="font-size:14px;">insights</span> Click a Branch to expand, then click any PC for its live diagnostics`;
        }
    }

    container.innerHTML = "";

    if (Object.keys(branchDataMap).length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:var(--space-2xl); color:var(--color-text-muted); font-size:var(--text-sm);">No active device nodes matching selection.</div>`;
        return;
    }

    for (const [branchName, pcs] of Object.entries(branchDataMap)) {
        let branchColor = "var(--color-primary)";
        let branchStateLabel = "Optimal Network";

        if (pcs.some(p => p.status === 'critical')) {
            branchColor = "var(--color-error)";
            branchStateLabel = "Urgent Action Required";
        } else if (pcs.some(p => p.status === 'warning')) {
            branchColor = "var(--color-warning)";
            branchStateLabel = "Warnings Active";
        }

        const isCurrentlyExpanded = expandedBranches.includes(branchName) || searchFilter !== "" || activeBranchFilter !== "" || currentStatusFilter !== "";
        const expansionClass = isCurrentlyExpanded ? "is-expanded" : "";

        let branchHtml = `
        <div class="branch-analytics-card ${expansionClass}" data-branch-name="${branchName}">
            <button class="branch-header-trigger" onclick="toggleBranchAccordion(this)">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <h2 style="font-size: var(--text-base); margin:0; display:flex; align-items:center; gap:8px; color: var(--color-text);">
                        ${branchName}
                        <span style="font-size: var(--text-xs); background: ${branchColor}15; color: ${branchColor}; padding: 2px 8px; border-radius: var(--radius-full); font-weight: var(--weight-semibold);">${branchStateLabel}</span>
                    </h2>
                    <p style="font-size: var(--text-xs); color: var(--color-text-secondary); margin: 0;">Cluster Allocations: <b>${pcs.length} Host Engines Visualized</b></p>
                </div>
                <span class="material-symbols-rounded chevron-icon">expand_more</span>
            </button>

            <div class="branch-expand-content">
                <div style="padding: var(--space-lg); background: var(--color-background); border-top: 1px solid var(--color-border);">
                    <div class="pc-card-grid">
        `;

        pcs.forEach(pc => {
            branchHtml += buildPcMiniCardHtml(pc);
        });

        branchHtml += `</div></div></div></div>`;
        container.innerHTML += branchHtml;
    }
}

/**
 * Compact "at a glance" card shown inside an expanded branch. Click opens the
 * full live dashboard for that single PC.
 */
function buildPcMiniCardHtml(pc) {
    let badgeClass = "success";
    if (pc.status === "warning") badgeClass = "warning";
    if (pc.status === "critical") badgeClass = "error";

    let netColor = "var(--color-success)";
    if (pc.networkStatus === "High Latency") netColor = "var(--color-warning)";
    if (pc.networkStatus === "Offline") netColor = "var(--color-error)";

    let cpuColor = pc.cpuTemp >= 80 ? "var(--color-error)" : (pc.cpuTemp >= 50 ? "var(--color-warning)" : "var(--color-success)");

    return `
    <div class="pc-mini-card" onclick="openPcModal('${pc.pcId}')">
        <div class="pc-mini-card-top">
            <div class="pc-mini-card-icon">
                <span class="material-symbols-rounded" style="font-size: 18px; color: var(--color-text-secondary);">computer</span>
            </div>
            <div style="flex: 1; min-width: 0;">
                <h4 class="pc-mini-card-id">${pc.pcId}</h4>
                <p class="pc-mini-card-user">${pc.user}</p>
            </div>
            <span class="status-badge ${badgeClass}" style="font-size: 9px;">${pc.status.toUpperCase()}</span>
        </div>
        <div class="pc-mini-card-stats">
            <span style="color: ${cpuColor};"><span class="material-symbols-rounded" style="font-size:13px;">memory</span>${Math.round(pc.cpuTemp)}°C</span>
            <span><span class="material-symbols-rounded" style="font-size:13px; color:#3b82f6;">hard_drive</span>${pc.computedStoragePercent}%</span>
            <span style="color: ${netColor};"><span class="material-symbols-rounded" style="font-size:13px;">settings_input_hdmi</span>${pc.networkStatus}</span>
        </div>
        <div class="pc-mini-card-hint">
            <span class="material-symbols-rounded" style="font-size:12px;">open_in_full</span>
            View live diagnostics
        </div>
    </div>`;
}

function toggleBranchAccordion(buttonElement) {
    const card = buttonElement.closest('.branch-analytics-card');
    if (card) card.classList.toggle('is-expanded');
}

/**
 * ==========================================================================
 * LIVE PC DETAIL MODAL
 * ==========================================================================
 */
function initModalControls() {
    const overlay = document.getElementById("pcModalOverlay");
    const closeBtn = document.getElementById("pcModalCloseBtn");

    if (closeBtn) closeBtn.addEventListener("click", closePcModal);
    if (overlay) {
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closePcModal();
        });
    }
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closePcModal();
    });
}

function openPcModal(pcId) {
    activeModalPcId = pcId;
    renderModalBody();
    const overlay = document.getElementById("pcModalOverlay");
    if (overlay) overlay.classList.add("is-visible");
}

function closePcModal() {
    activeModalPcId = null;
    const overlay = document.getElementById("pcModalOverlay");
    if (overlay) overlay.classList.remove("is-visible");
}

function refreshModalIfOpen() {
    if (!activeModalPcId) return;
    const pc = pcRegistry.find(p => p.pcId === activeModalPcId);
    if (!pc) {
        closePcModal();
        return;
    }
    renderModalBody();
}

function renderModalBody() {
    const pc = pcRegistry.find(p => p.pcId === activeModalPcId);
    const body = document.getElementById("pcModalBody");
    if (!pc || !body) return;

    let badgeClass = "success";
    if (pc.status === "warning") badgeClass = "warning";
    if (pc.status === "critical") badgeClass = "error";

    let statusColor = "var(--color-success)";
    if (pc.status === "warning") statusColor = "var(--color-warning)";
    if (pc.status === "critical") statusColor = "var(--color-error)";

    let netColor = "var(--color-success)";
    if (pc.networkStatus === "High Latency") netColor = "var(--color-warning)";
    if (pc.networkStatus === "Offline") netColor = "var(--color-error)";

    let kbdColor = pc.keyboard.toLowerCase() === "malfunction" ? "var(--color-error)" : "var(--color-success)";
    let cpuColor = pc.cpuTemp >= 80 ? "var(--color-error)" : (pc.cpuTemp >= 50 ? "var(--color-warning)" : "var(--color-success)");
    let boardColor = pc.boardTemp >= 65 ? "var(--color-error)" : (pc.boardTemp >= 45 ? "var(--color-warning)" : "var(--color-success)");
    let storageColor = pc.computedStoragePercent >= 95 ? "var(--color-error)" : (pc.computedStoragePercent >= 90 ? "var(--color-warning)" : "var(--color-success)");

    const adviceBannerHtml = getSystemPreventionAdvisoryHtml(pc);

    // Resolve CSS custom properties to literal colors for SVG stroke attributes
    // (SVG fill/stroke happily accept var(--x), but resolving here keeps the
    // gauge bands crisp even in environments with stricter SVG CSS support).
    const cpuGaugeColor = cpuColor;
    const boardGaugeColor = boardColor;
    const storageGaugeColor = storageColor;

    body.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap: var(--space-md); margin-bottom: var(--space-sm); padding-right: var(--space-xl);">
            <div>
                <h2 style="margin:0; font-size: var(--text-xl); color: var(--color-text);">${pc.pcId}</h2>
                <p style="margin:4px 0 0 0; font-size: var(--text-sm); color: var(--color-text-secondary);">User: <b>${pc.user}</b> &nbsp;•&nbsp; Branch: <b>${pc.branch}</b></p>
            </div>
            <span class="status-badge ${badgeClass}" style="white-space:nowrap;">STATUS: ${pc.status.toUpperCase()}</span>
        </div>

        <div class="live-pulse-indicator"><span class="live-dot"></span>Live — refreshing every few seconds</div>

        <!-- LIVE DIAGNOSTICS DASHBOARD -->
        <div class="live-dash-stats">
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">Status</span>
                <span class="live-dash-stat-value" style="color:${statusColor};">${pc.status.toUpperCase()}</span>
            </div>
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">CPU Temp</span>
                <span class="live-dash-stat-value" style="color:${cpuColor};">${Math.round(pc.cpuTemp)}°C</span>
            </div>
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">Board Temp</span>
                <span class="live-dash-stat-value" style="color:${boardColor};">${Math.round(pc.boardTemp)}°C</span>
            </div>
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">Storage Used</span>
                <span class="live-dash-stat-value" style="color:${storageColor};">${pc.computedStoragePercent}%</span>
            </div>
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">Network</span>
                <span class="live-dash-stat-value" style="color:${netColor}; font-size:14px;">${pc.networkStatus}</span>
            </div>
            <div class="live-dash-stat">
                <span class="live-dash-stat-label">Keyboard</span>
                <span class="live-dash-stat-value" style="color:${kbdColor}; font-size:14px;">${pc.keyboard}</span>
            </div>
        </div>

        <div class="gauge-row">
            <div class="gauge-panel">
                <span class="gauge-panel-title">CPU Temp</span>
                ${buildGaugeSvg(pc.cpuTemp, 100, cpuGaugeColor, Math.round(pc.cpuTemp), "°C")}
            </div>
            <div class="gauge-panel">
                <span class="gauge-panel-title">Board Temp</span>
                ${buildGaugeSvg(pc.boardTemp, 100, boardGaugeColor, Math.round(pc.boardTemp), "°C")}
            </div>
            <div class="gauge-panel">
                <span class="gauge-panel-title">Storage Used</span>
                ${buildGaugeSvg(pc.computedStoragePercent, 100, storageGaugeColor, pc.computedStoragePercent, "%")}
            </div>
        </div>

        <div class="chart-panel">
            <div class="chart-panel-title">Usage History</div>
            ${buildHistoryChartSvg(pc.history, [{ key: "cpu", color: "#d4a72c" }, { key: "board", color: "#73bf69" }], pc.pcId.replace(/[^a-zA-Z0-9]/g, ""))}
            <div class="chart-legend">
                <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#d4a72c;"></span>CPU Temp</span>
                <span class="chart-legend-item"><span class="chart-legend-dot" style="background:#73bf69;"></span>Board Temp</span>
            </div>
        </div>

        <div class="event-log-panel">
            <div class="chart-panel-title">Live Event Log</div>
            <div class="event-log-list">
                ${pc.eventLog.length === 0
                    ? `<div style="color:var(--color-text-muted); font-size:12px; padding:6px 0;">No events recorded yet — monitoring nominal.</div>`
                    : pc.eventLog.slice(0, 6).map(ev => `
                        <div class="event-log-item">
                            <span class="event-log-dot" style="background:${severityColor(ev.severity)};"></span>
                            <span class="event-log-time">${ev.time}</span>
                            <span class="event-log-message">${ev.message}</span>
                        </div>
                    `).join("")
                }
            </div>
        </div>
        <!-- END LIVE DIAGNOSTICS DASHBOARD -->

        <div class="embedded-hwmonitor-tree" style="display: flex; flex-direction: column; gap: var(--space-xs); font-family: 'Segoe UI', -apple-system, sans-serif; font-size: 13px;">

            <div class="hw-tree-item" style="display: flex; align-items: center; gap: 8px; color: var(--color-text);">
                <span class="material-symbols-rounded" style="font-size: 15px; color: #a855f7;">memory</span>
                <b>Central Processing Unit (CPU) Thermals &amp; Cores</b>
            </div>
            <div class="hw-tree-sub" style="padding-left: 24px; color: var(--color-text-secondary); display: flex; flex-direction: column; gap: 2px;">
                <div>⚡ Core Max Temp: <span style="color: ${cpuColor}; font-weight: 600;">${Math.round(pc.cpuTemp)}°C</span></div>
                <div>⚡ Motherboard VRM: <span>${Math.round(pc.boardTemp)}°C</span></div>
                <div>⚡ Core Voltage VDD: <span style="color: var(--color-success);">1.216 V</span></div>
            </div>

            <div style="height: 4px;"></div>

            <div class="hw-tree-item" style="display: flex; align-items: center; gap: 8px; color: var(--color-text);">
                <span class="material-symbols-rounded" style="font-size: 15px; color: #3b82f6;">hard_drive</span>
                <b>Logical Volumes &amp; Storage Footprints</b>
            </div>
            <div class="hw-tree-sub" style="padding-left: 24px; color: var(--color-text-secondary); display: flex; flex-direction: column; gap: 2px;">
                <div style="width: 100%; max-width: 400px; margin-bottom: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
                        <span>💾 Volume Capacity Used:</span>
                        <span style="font-weight: 600; color: var(--color-text);">${Math.round(pc.used)}GB / ${Math.round(pc.capacity)}GB (${pc.computedStoragePercent}%)</span>
                    </div>
                    <div class="progress-bar-container">
                        <div class="progress-bar-fill ${badgeClass}" style="width: ${pc.computedStoragePercent}%;"></div>
                    </div>
                </div>
                <div>💾 Sector Verification: <span style="font-size: 12px; color: ${pc.sectorStatus.toLowerCase().includes('normal') ? 'var(--color-text-muted)' : 'var(--color-error)'}; font-weight: ${pc.sectorStatus.toLowerCase().includes('normal') ? '400' : '600'};">${pc.sectorStatus}</span></div>
                <div>💾 Available Cluster Allocation: <span style="color: var(--color-success); font-weight: 600;">${Math.round(pc.free)}GB Left</span></div>
            </div>

            <div style="height: 4px;"></div>

            <div class="hw-tree-item" style="display: flex; align-items: center; gap: 8px; color: var(--color-text);">
                <span class="material-symbols-rounded" style="font-size: 15px; color: #ec4899;">settings_input_hdmi</span>
                <b>Connectivity Interfaces &amp; Peripherals</b>
            </div>
            <div class="hw-tree-sub" style="padding-left: 24px; color: var(--color-text-secondary); display: flex; flex-direction: column; gap: 2px;">
                <div>🔌 Ethernet Link State: <span style="color: ${netColor}; font-weight: 600;">${pc.networkStatus}</span></div>
                <div>🔌 HID Keyboard Input: <span style="color: ${kbdColor}; font-weight: 600;">${pc.keyboard}</span></div>
                <div>🔌 Bus Interface Poll Rate: <span style="color: var(--color-text-muted);">1000 Hz</span></div>
            </div>

            ${adviceBannerHtml}
        </div>
    `;
}

function initThemeToggle() {
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return;

    const options = toggle.querySelectorAll(".theme-option");
    options.forEach(opt => {
        opt.addEventListener("click", () => {
            options.forEach(o => o.classList.remove("active"));
            opt.classList.add("active");
            document.documentElement.setAttribute("data-theme", opt.getAttribute("data-theme"));
        });
    });
}