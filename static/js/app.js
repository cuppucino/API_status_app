// static/js/app.js
const app = Vue.createApp({
  data() {
    return {
      apis: [],
      charts: {},          // { [apiName]: Chart instance } for sparklines
      showModal: false,
      selectedApi: {},
      detailChart: null,
      search: "",
      statusFilter: "All",
      categoryFilter: "All",
      timeRange: "24h",
      fetchError: null,
    };
  },

  computed: {
    categoryOptions() {
      const set = new Set(this.apis.map(a => a.category));
      return Array.from(set).sort();
    },
    filteredApis() {
      return this.apis.filter(a => {
        const q = this.search.toLowerCase();
        const matchesSearch = a.name.toLowerCase().includes(q);
        const matchesStatus = this.statusFilter === "All" || a.status === this.statusFilter;
        const matchesCategory = this.categoryFilter === "All" || a.category === this.categoryFilter;
        return matchesSearch && matchesStatus && matchesCategory;
      });
    },
    groupedApis() {
      const groups = {};
      this.filteredApis.forEach(a => {
        (groups[a.category] = groups[a.category] || []).push(a);
      });
      return groups;
    },
    overallStatus() {
      if (this.apis.some(a => a.status === "Offline")) {
        return { message: "Major System Outage", class: "offline" };
      }
      if (this.apis.some(a => a.status === "Degraded")) {
        return { message: "Degraded Performance", class: "degraded" };
      }
      return { message: "All Systems Operational", class: "online" };
    },
  },

  methods: {
    // Generates a URL-safe, lowercase-and-dashed string from a given name.

    // Cleans up a name like "User Service" to be "user-service" so it's safe for an HTML ID.
    slug(name) {
      return String(name).toLowerCase().replace(/[^a-z0-9_-]+/gi, "-");
    },

    // Asynchronously fetches the latest API status data from the '/api/status' endpoint.
    // It preserves and updates the historical data for sparklines and then triggers a UI update.

    // Every few seconds, this asks the server, "How is everyone doing?"
    // It remembers the old health scores to draw the tiny graphs and tells the screen to update.
    async fetchStatus() {
      try {
        const res = await axios.get("/api/status");
        const data = res.data;

        // Preserve and extend sparkline history safely
        data.forEach(api => {
          const existing = this.apis.find(a => a.name === api.name);
          if (existing && Array.isArray(existing.history)) {
            api.history = existing.history;
            api.history.push(api.response_time);
            if (api.history.length > 50) api.history.shift();
          } else {
            api.history = [api.response_time];
          }
        });

        this.apis = data;

        // Draw/update charts only after DOM has the canvases
        this.$nextTick(() => this.updateSparklines());
      } catch (e) {
        console.error(e);
        this.fetchError = "Failed to fetch status.";
      }
    },

    // Manages the lifecycle of all sparkline charts.
    // It destroys instances for off-screen canvases (due to filtering) and creates or updates charts for all visible canvases.

    // This is the artist for all the little graphs on the cards.
    // It erases graphs for cards you've filtered out and draws or updates the graphs for all the cards you can see.
    updateSparklines() {
      const visibleApiNames = new Set(this.filteredApis.map(a => a.name));

      // 1) Destroy charts whose cards disappeared (filters/search)
      for (const apiName in this.charts) {
        if (!visibleApiNames.has(apiName)) {
          try { this.charts[apiName].destroy(); } catch {}
          delete this.charts[apiName];
        }
      }

      // 2) Create or update charts for the currently visible cards
      this.filteredApis.forEach(api => {
        const canvasId = 'spark-' + this.slug(api.name);
        const el = document.getElementById(canvasId);
        if (!el) return; // canvas not in DOM yet (rare race) → skip this tick

        const existing = this.charts[api.name];

        if (!existing) {
          // Create with v4 options; pass CLONED data arrays
          this.charts[api.name] = new Chart(el, {
            type: 'line',
            data: {
              labels: Array(api.history.length).fill(''),
              datasets: [{
                data: [...api.history],      // clone to avoid Vue-Chart mutation loops
                borderWidth: 2,
                tension: 0.4,
                pointRadius: 0,
                fill: false,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: { x: { display: false }, y: { display: false } },
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
              animation: false,
            },
          });
        } else {
          // Update existing (again: clone arrays)
          existing.data.labels = Array(api.history.length).fill('');
          existing.data.datasets[0].data = [...api.history];
          existing.update('none'); // no animation
        }
      });
    },

    // Sets the 'selectedApi' data property, makes the modal visible, and locks background scrolling.
    // It then renders the detailed chart inside the modal.

    // When you click a card, this makes the big pop-up window appear.
    // It tells the pop-up *which* API you clicked on, freezes the background, and tells the big graph to draw itself.
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

    // Hides the modal, restores background scrolling, and destroys the detail chart instance to prevent memory leaks.

    // This closes the pop-up window, lets you scroll the main page again, and cleans up the big graph.
    closeModal() {
      this.showModal = false;
      document.body.style.overflow = "";
      if (this.detailChart) {
        try { this.detailChart.destroy(); } catch {}
        this.detailChart = null;
      }
    },

    // Manages the lifecycle of the large modal chart.
    // It destroys any existing chart instance and creates a new one using the 'selectedApi' data.

    // This is the artist for the *big* graph in the pop-up.
    // It erases any old graph and draws a new, detailed one for the API you're looking at.
    renderDetailChart() {
      const canvas = document.getElementById("detailChart");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (this.detailChart) {
        try { this.detailChart.destroy(); } catch {}
        this.detailChart = null;
      }

      const colorByStatus = (s) => {
        const m = { online: '#90ee90', degraded: '#ffe600', offline: '#ff6347' };
        return m[(s || '').toLowerCase()] || '#66b3ff';
      };

      this.detailChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: Array(this.selectedApi.history.length).fill(""),
          datasets: [{
            label: "Response Time (s)",
            data: [...this.selectedApi.history],   // clone
            borderColor: colorByStatus(this.selectedApi.status),
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 0,
            fill: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { display: false } },
          },
          plugins: { legend: { display: false } },
          animation: false,
        },
      });
    },

    // Utility function to auto-scroll the modal's log list to the bottom, ensuring the latest log is visible.
    
    // This makes the log list in the pop-up automatically scroll down to the newest message, just like a chat app.
    scrollLogsToEnd(force = false) {
      const el = this.$refs.logsList;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (force || nearBottom) el.scrollTop = el.scrollHeight;
    },
  },

  watch: {
    search()        { this.$nextTick(() => this.updateSparklines()); },
    statusFilter()  { this.$nextTick(() => this.updateSparklines()); },
    categoryFilter(){ this.$nextTick(() => this.updateSparklines()); },
    selectedApi()   { if (this.showModal) this.$nextTick(() => this.renderDetailChart()); },
  },

  mounted() {
    this.fetchStatus();
    setInterval(this.fetchStatus, 5000);

    // Esc to close modal
    window.addEventListener("keydown", (e) => {
      if (this.showModal && e.key === "Escape") this.closeModal();
    });
  },
});

app.mount("#app");