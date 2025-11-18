const app = Vue.createApp({
  data() {
    return {
      apis: [],
      orderMap: Object.create(null),
      nextOrder: 0,
      showModal: false,
      selectedApi: {},
      detailChart: null,
      search: "",
      statusFilter: "All",
      categoryFilter: "All",
      timeRange: "24h",
      fetchError: null,
      tooltip: {
        show: false,
        x: 0,
        y: 0,
        point: null, // { value, ts, ok, status }
      },

      isLoading: false,

      refreshInterval: 30000, // Default to 5 seconds
      fetchIntervalId: null, // To store the timer ID
    };
  },

  computed: {
    categoryOptions() {
      const set = new Set(this.apis.map((a) => a.category));
      return Array.from(set).sort();
    },

    filteredApis() {
      const q = this.search.toLowerCase();
      const list = this.apis.filter((a) => {
        const matchesSearch = a.name.toLowerCase().includes(q);
        const matchesStatus =
          this.statusFilter === "All" || a.status === this.statusFilter;
        const matchesCategory =
          this.categoryFilter === "All" || a.category === this.categoryFilter;
        return matchesSearch && matchesStatus && matchesCategory;
      });
      list.sort((a, b) => (a.__order ?? 0) - (b.__order ?? 0));
      return list;
    },

    groupedApis() {
      const groups = {};
      this.filteredApis.forEach((a) => {
        (groups[a.category] = groups[a.category] || []).push(a);
      });
      for (const cat in groups) {
        groups[cat].sort((x, y) => (x.__order ?? 0) - (y.__order ?? 0));
      }
      return groups;
    },

    // --- tooltip display values ---
    tooltipLatency() {
      const p = this.tooltip.point;
      if (!p || typeof p.value !== "number") return "N/A";
      return p.value.toFixed(3) + "s";
    },
    tooltipStatusCode() {
      const p = this.tooltip.point;
      if (!p || p.status == null) return "";
      if (p.status === 0) return "no response";
      if (p.status >= 300 && p.status < 400) return `${p.status} (Redirect)`;
      return p.status;
    },
    tooltipReason() {
      const p = this.tooltip.point;
      if (!p) return "";
      if (!p.ok) return "Offline — health check did not return a 2xx status.";
      if (typeof p.value !== "number")
        return "No latency data, but health check is Online.";
      if (p.value > 1.0)
        return "Very slow (>1s) — likely degraded or under heavy load.";
      if (p.value > 0.5) return "Slow (0.5–1s) — approaching SLA limit.";
      return "Healthy (<0.5s) — within normal parameters.";
    },
  },

  methods: {
    // ----- stable order -----
    ensureStableOrder(list) {
      list.forEach((api) => {
        if (this.orderMap[api.name] == null) {
          this.orderMap[api.name] = this.nextOrder++;
        }
        api.__order = this.orderMap[api.name];
      });
      list.sort((a, b) => a.__order - b.__order);
      return list;
    },
    loadSavedOrder() {
      try {
        const saved = JSON.parse(localStorage.getItem("apiOrder") || "{}");
        if (saved && typeof saved === "object") {
          this.orderMap = saved;
          const max = Math.max(-1, ...Object.values(saved));
          this.nextOrder = isFinite(max) ? max + 1 : 0;
        }
      } catch {}
    },
    saveOrder() {
      try {
        localStorage.setItem("apiOrder", JSON.stringify(this.orderMap));
      } catch {}
    },

    slug(name) {
      return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gi, "-");
    },

    // ----- history slice -----
    historySlice(api) {
      if (!api) return { values: [], labels: [], ok: [], status: [] };

      const values = Array.isArray(api.history) ? api.history.slice() : [];
      const labels = Array.isArray(api.history_ts)
        ? api.history_ts.slice()
        : [];
      const okFlags = Array.isArray(api.history_ok)
        ? api.history_ok.slice()
        : [];
      const statusCodes = Array.isArray(api.history_status)
        ? api.history_status.slice()
        : [];

      const len = values.length;
      let n;
      switch (this.timeRange) {
        case "24h":
          n = 20;
          break;
        case "7d":
          n = 40;
          break;
        case "30d":
        default:
          n = 60;
          break;
      }
      const start = Math.max(0, len - n);

      return {
        values: values.slice(start),
        labels: labels.slice(start),
        ok: okFlags.slice(start),
        status: statusCodes.slice(start),
      };
    },

    historyBars(api) {
      const slice = this.historySlice(api);
      const bars = [];
      const len = slice.values.length;
      for (let i = 0; i < len; i++) {
        bars.push({
          value: slice.values[i],
          ts: slice.labels[i] || "",
          ok: slice.ok[i] !== 0,
          status: slice.status[i] || 0,
        });
      }
      return bars;
    },

    latencyClass(value, ok) {
      if (!ok) return "bar-error";
      if (typeof value !== "number") return "bar-ok";
      if (value > 1.0) return "bar-error"; // >1s
      if (value > 0.5) return "bar-slow"; // 0.5–1s
      return "bar-ok"; // <0.5s
    },

    barHeight(value) {
      if (typeof value !== "number" || value <= 0) return "15%";
      const maxSecs = 0.6;
      const normalized = Math.min(value / maxSecs, 1);
      const pct = 10 + normalized * 90;
      return pct + "%";
    },

    // ----- tooltip helpers -----
    condPass(kind) {
      const p = this.tooltip.point;
      if (!p) return false;
      if (kind === "status") return !!p.ok;
      if (kind === "fast") return typeof p.value === "number" && p.value <= 0.5;
      if (kind === "online") return !!p.ok;
      return false;
    },
    condClass(kind) {
      return this.condPass(kind)
        ? "tt-cond tt-cond-pass"
        : "tt-cond tt-cond-fail";
    },

    showTooltip(evt, point) {
      if (!evt) return;
      this.tooltip.show = true;
      this.tooltip.point = point;
      this.$nextTick(() => {
        this.updateTooltipPos(evt);
      });
    },

    moveTooltip(evt) {
      if (!evt || !this.tooltip.show || !this.$refs.tooltipElement) return;
      this.updateTooltipPos(evt);
    },

    hideTooltip() {
      this.tooltip.show = false;
      this.tooltip.point = null;
    },

    updateTooltipPos(evt) {
      const offset = 16;
      const tooltipEl = this.$refs.tooltipElement;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight; // Add window height

      // Default position: bottom-right of pointer
      let newX = evt.clientX + offset;
      let newY = evt.clientY + offset;

      if (tooltipEl) {
        const tooltipWidth = tooltipEl.offsetWidth;
        const tooltipHeight = tooltipEl.offsetHeight; // Add tooltip height

        // --- Check X-axis (right edge) ---
        if (evt.clientX + offset + tooltipWidth > windowWidth) {
          newX = evt.clientX - tooltipWidth - offset; // Flip to the left
        }

        // --- Check Y-axis (bottom edge) ---
        if (evt.clientY + offset + tooltipHeight > windowHeight) {
          newY = evt.clientY - tooltipHeight - offset; // Flip to the top
        }
      }

      this.tooltip.x = newX;
      this.tooltip.y = newY;
    },

    timeAgo(isoString) {
      if (!isoString) return "N/A";
      const date = new Date(isoString.replace(" ", "T"));
      const seconds = Math.floor((new Date() - date) / 1000);

      if (isNaN(seconds)) return isoString; // Fallback for invalid dates

      if (seconds < 5) return "just now";
      if (seconds < 60) return `${seconds} seconds ago`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
      return `${Math.floor(seconds / 86400)} days ago`;
    },

    startPolling() {
      // Clear any old timer
      if (this.fetchIntervalId) {
        clearInterval(this.fetchIntervalId);
      }

      // If interval is 0 (Paused), don't start a new timer
      const interval = parseInt(this.refreshInterval, 10);
      if (interval > 0) {
        // Set the new timer
        this.fetchIntervalId = setInterval(this.fetchStatus, interval);
      }
    },

    // ----- fetch + modal/chart -----
    async fetchStatus() {
      // --- NEW: Clear the automatic timer ---
      if (this.fetchIntervalId) {
        clearInterval(this.fetchIntervalId);
      }
      // Prevent multiple fetches at the same time
      if (this.isLoading) return;

      this.isLoading = true; // Set loading state
      this.fetchError = null; // Clear old errors

      try {
        const res = await axios.get("/api/status");
        const data = res.data;

        this.ensureStableOrder(data);
        this.apis = data;
        this.saveOrder();

        if (this.showModal && this.selectedApi && this.selectedApi.name) {
          const updated = this.apis.find(
            (a) => a.name === this.selectedApi.name
          );
          if (updated) {
            this.selectedApi = updated;
          }
        }

        this.$nextTick(() => {
          if (this.showModal) {
            this.renderDetailChart();
            this.scrollLogsToEnd();
          }
        });
      } catch (e) {
        console.error(e);
        this.fetchError = "Failed to fetch status.";
      } finally {
        this.isLoading = false; // Clear loading state

        // --- Restart the automatic timer ---
        this.startPolling();
      }
    },

    openModal(api) {
      this.selectedApi = api;
      this.showModal = true;
      document.body.style.overflow = "hidden";
      this.$nextTick(() => {
        this.$refs.modalRoot && this.$refs.modalRoot.focus();
        this.renderDetailChart();
        this.scrollLogsToEnd(true);
      });
    },

    closeModal() {
      this.showModal = false;
      document.body.style.overflow = "";
      if (this.detailChart) {
        try {
          this.detailChart.destroy();
        } catch {}
        this.detailChart = null;
      }
      this.hideTooltip();
    },

    renderDetailChart() {
      const canvas = document.getElementById("detailChart");
      if (!canvas || !this.selectedApi) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (this.detailChart) {
        try {
          this.detailChart.destroy();
        } catch {}
        this.detailChart = null;
      }

      const slice = this.historySlice(this.selectedApi);
      if (!slice.values.length) return;

      const colorByStatus = (s) => {
        const m = { online: "#90ee90", offline: "#ff6347" };
        return m[(s || "").toLowerCase()] || "#66b3ff";
      };

      const lineColor = colorByStatus(this.selectedApi.status);
      const labels = slice.labels;

      this.detailChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Response Time (s)",
              data: slice.values,
              borderColor: lineColor,
              borderWidth: 2,
              tension: 0.3,
              pointRadius: 0,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                display: true,
                color: "#888",
                autoSkip: true,
                maxTicksLimit: 6,
                maxRotation: 0,
                minRotation: 0,
              },
            },
            y: {
              grid: { color: "rgba(255,255,255,0.08)" },
              ticks: {
                display: true,
                color: "#888",
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              callbacks: {
                title: (items) => {
                  const idx = items[0].dataIndex;
                  return labels[idx] || "";
                },
                label: (ctx) => {
                  const v = ctx.parsed.y;
                  return `${v.toFixed(3)}s`;
                },
              },
            },
          },
          animation: false,
        },
      });
    },

    scrollLogsToEnd(force = false) {
      const el = this.$refs.logsList;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (force || nearBottom) el.scrollTop = el.scrollHeight;
    },
  },

  watch: {
    refreshInterval() {
      this.startPolling();
    },
    timeRange() {
      if (this.showModal) {
        this.$nextTick(() => this.renderDetailChart());
      }
    },
    selectedApi() {
      if (this.showModal) {
        this.$nextTick(() => this.renderDetailChart());
      }
    },
  },

  mounted() {
    this.loadSavedOrder();
    this.fetchStatus();
    this.startPolling();

    window.addEventListener("keydown", (e) => {
      if (this.showModal && e.key === "Escape") this.closeModal();
    });
  },
});

app.mount("#app");
