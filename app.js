import { SimulationEngine } from './engine.js';

async function loadScenario() {
  const resp = await fetch('scenario.json');
  if (!resp.ok) {
    throw new Error('Failed to load scenario.json');
  }
  return resp.json();
}

function validateScenario(data) {
  const errors = [];
  const requiredMeta = ['region', 'seed', 'reservePercent', 'priceCap'];
  if (!data.meta) errors.push('meta');
  if (!data.clock) errors.push('clock');
  if (!Array.isArray(data.zones) || data.zones.length !== 3) errors.push('zones[3]');
  if (!Array.isArray(data.transmission) || data.transmission.length !== 2) errors.push('transmission[2]');
  if (!Array.isArray(data.thermalUnits) || !data.thermalUnits.length) errors.push('thermalUnits');
  if (!data.renewables) errors.push('renewables');
  if (!data.battery) errors.push('battery');
  if (data.meta) {
    for (const field of requiredMeta) {
      if (typeof data.meta[field] === 'undefined') {
        errors.push(`meta.${field}`);
      }
    }
  }
  if (data.clock) {
    const clockFields = ['start', 'durationHours', 'tickMinutes'];
    for (const field of clockFields) {
      if (!data.clock[field]) errors.push(`clock.${field}`);
    }
  }
  return errors;
}

function $(selector) {
  return document.querySelector(selector);
}

function createEl(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.text) el.textContent = opts.text;
  if (opts.html) el.innerHTML = opts.html;
  return el;
}

function setupKeyboard(simUI) {
  document.addEventListener('keydown', (evt) => {
    if (evt.target && ['INPUT', 'TEXTAREA'].includes(evt.target.tagName)) {
      return;
    }
    switch (evt.key.toLowerCase()) {
      case 'p':
        simUI.handlePause();
        break;
      case 'r':
        simUI.handleResume();
        break;
      case ' ': // space toggles pause/resume
        evt.preventDefault();
        if (simUI.engine.running) {
          simUI.handlePause();
        } else {
          simUI.handleResume();
        }
        break;
      case '1':
        simUI.updateSpeed('1');
        break;
      case '4':
        simUI.updateSpeed('4');
        break;
    }
  });
}

class SimulationUI {
  constructor(engine, scenario) {
    this.engine = engine;
    this.scenario = scenario;
    this.tickTimer = null;
    this.speed = 1;
    this.lastAction = null;
    this.eventLogEl = $('#event-log');
    this.feedbackEl = $('#action-feedback');
    this.lastEventId = null;
    this.initLayout();
    this.bindControls();
    setupKeyboard(this);
  }

  initLayout() {
    const zonesContainer = $('#zones');
    zonesContainer.innerHTML = '';
    for (const zone of this.scenario.zones) {
      const zoneDiv = createEl('div', { className: 'zone', html: `<h3>${zone.name}</h3><div class="zone-load">Load: 0 MW</div><div class="zone-price">Price: $0</div>` });
      zoneDiv.dataset.zone = zone.id;
      zonesContainer.appendChild(zoneDiv);
    }
    const linksContainer = $('#links');
    linksContainer.innerHTML = '';
    for (const link of this.scenario.transmission) {
      const linkDiv = createEl('div', { className: 'link', text: `${link.from.toUpperCase()} ↔ ${link.to.toUpperCase()} (0 MW)` });
      linkDiv.dataset.link = link.id;
      linksContainer.appendChild(linkDiv);
    }

    $('#scenario-meta').textContent = `${this.scenario.meta.region} | Seed ${this.scenario.meta.seed}`;

    const unitContainer = $('#unit-actions');
    unitContainer.innerHTML = '';
    for (const unit of this.scenario.thermalUnits) {
      const button = createEl('button', { text: `${unit.name} - OFF` });
      button.dataset.unit = unit.id;
      button.addEventListener('click', () => this.handleUnitToggle(unit.id));
      unitContainer.appendChild(button);
    }
    this.updateActionAvailability();
  }

  bindControls() {
    $('#start-btn').addEventListener('click', () => this.handleStart());
    $('#pause-btn').addEventListener('click', () => this.handlePause());
    $('#resume-btn').addEventListener('click', () => this.handleResume());
    $('#reset-btn').addEventListener('click', () => this.handleReset());
    $('#speed-select').addEventListener('change', (evt) => this.updateSpeed(evt.target.value));
    $('#undo-btn').addEventListener('click', () => this.handleUndo());
    $('#toggle-dev').addEventListener('click', () => $('#dev').classList.toggle('hidden'));
    $('#toggle-panels').addEventListener('click', () => {
      $('#actions').classList.toggle('hidden');
      $('#events').classList.toggle('hidden');
    });

    document.querySelectorAll('input[name="battery-mode"]').forEach((input) => {
      input.addEventListener('change', (evt) => {
        this.engine.setBatteryMode(evt.target.value);
      });
    });

    $('#apply-dev').addEventListener('click', () => this.applyDevOverrides());
    $('#export-csv').addEventListener('click', () => this.exportCsv());
  }

  handleStart() {
    const qty = Number($('#dayahead-qty').value);
    const price = Number($('#dayahead-price').value || this.scenario.meta.dayAheadDefaultPrice);
    try {
      this.engine.startRun({ quantity: qty, price });
    } catch (err) {
      this.showFeedback(err.message);
      return;
    }
    $('#start-btn').disabled = true;
    $('#pause-btn').disabled = false;
    $('#reset-btn').disabled = false;
    $('#speed-select').disabled = false;
    $('#dayahead-qty').disabled = true;
    $('#dayahead-price').disabled = true;
    this.feedbackEl.textContent = '';
    this.resumeTicking();
  }

  handlePause() {
    if (!this.engine.running) return;
    this.stopTicking();
    this.engine.pause();
    $('#pause-btn').disabled = true;
    $('#resume-btn').disabled = false;
  }

  handleResume() {
    if (!this.engine.canResume()) return;
    this.engine.resume();
    $('#pause-btn').disabled = false;
    $('#resume-btn').disabled = true;
    this.resumeTicking();
  }

  handleReset() {
    this.stopTicking();
    this.engine.reset();
    $('#start-btn').disabled = false;
    $('#pause-btn').disabled = true;
    $('#resume-btn').disabled = true;
    $('#reset-btn').disabled = true;
    $('#speed-select').disabled = true;
    $('#dayahead-qty').disabled = false;
    $('#dayahead-price').disabled = false;
    $('#undo-btn').disabled = true;
    this.eventLogEl.innerHTML = '';
    $('#kpi-unmet').textContent = '0';
    $('#kpi-price').textContent = '$0';
    $('#kpi-emissions').textContent = '0';
    $('#kpi-cash').textContent = '$0';
    $('#scorecard').classList.add('hidden');
    $('#score-summary').innerHTML = '';
    $('#score-badges').innerHTML = '';
    this.feedbackEl.textContent = '';
    this.lastEventId = null;
    this.updateActionAvailability();
    this.updateBatteryUI();
    this.renderTick(this.engine.currentSnapshot());
  }

  handleUnitToggle(unitId) {
    if (!this.engine.running && !this.engine.preRun) {
      this.showFeedback('Start the simulation before toggling units.');
      return;
    }
    const result = this.engine.toggleUnit(unitId);
    if (!result.ok) {
      this.showFeedback(result.reason);
    } else {
      this.lastAction = { type: 'unit', unitId, previous: result.previousState, tick: this.engine.state.tickIndex };
      $('#undo-btn').disabled = false;
      this.feedbackEl.textContent = '';
      this.updateActionAvailability();
      this.renderTick(this.engine.currentSnapshot());
    }
  }

  handleUndo() {
    if (!this.lastAction) return;
    const currentHour = Math.floor(this.engine.state.tickIndex / (60 / this.engine.tickMinutes));
    const actionHour = Math.floor(this.lastAction.tick / (60 / this.engine.tickMinutes));
    if (currentHour !== actionHour) {
      this.showFeedback('Undo unavailable: more than an hour has passed.');
      return;
    }
    if (this.lastAction.type === 'unit') {
      this.engine.restoreUnitState(this.lastAction.unitId, this.lastAction.previous);
      this.feedbackEl.textContent = 'Last unit action undone.';
      $('#undo-btn').disabled = true;
      this.updateActionAvailability();
      this.renderTick(this.engine.currentSnapshot());
    }
  }

  updateSpeed(value) {
    this.speed = Number(value);
    if (this.tickTimer) {
      this.stopTicking();
      this.resumeTicking();
    }
  }

  resumeTicking() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    const baseInterval = 500;
    const interval = baseInterval / this.speed;
    this.tickTimer = setInterval(() => {
      const snapshot = this.engine.step();
      this.renderTick(snapshot);
      this.updateActionAvailability();
      if (snapshot.done) {
        this.stopTicking();
        this.showScorecard();
      }
    }, interval);
  }

  stopTicking() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  renderTick(snapshot) {
    if (!snapshot) return;
    $('#clock-display').textContent = snapshot.timeLabel;
    for (const zone of snapshot.zones) {
      const zoneDiv = document.querySelector(`.zone[data-zone="${zone.id}"]`);
      if (!zoneDiv) continue;
      zoneDiv.querySelector('.zone-load').textContent = `Load: ${zone.load.toFixed(1)} MW`;
      zoneDiv.querySelector('.zone-price').textContent = `Price: $${zone.price.toFixed(1)}`;
      zoneDiv.classList.toggle('congested', zone.congested);
    }
    for (const link of snapshot.links) {
      const linkDiv = document.querySelector(`.link[data-link="${link.id}"]`);
      if (!linkDiv) continue;
      const direction = link.flow >= 0 ? `${link.from.toUpperCase()} → ${link.to.toUpperCase()}` : `${link.to.toUpperCase()} → ${link.from.toUpperCase()}`;
      linkDiv.textContent = `${direction} (${Math.abs(link.flow).toFixed(1)} / ${link.limit} MW)`;
      linkDiv.classList.toggle('congested', link.congested);
    }

    $('#kpi-unmet').textContent = snapshot.kpis.unmet.toFixed(2);
    $('#kpi-price').textContent = `$${snapshot.kpis.avgPrice.toFixed(2)}`;
    $('#kpi-emissions').textContent = snapshot.kpis.emissions.toFixed(2);
    $('#kpi-cash').textContent = `$${snapshot.kpis.cash.toFixed(0)}`;

    if (snapshot.lastEvent && snapshot.lastEvent.id !== this.lastEventId) {
      this.lastEventId = snapshot.lastEvent.id;
      const li = createEl('li', { html: `<strong>${snapshot.lastEvent.time}</strong> — ${snapshot.lastEvent.message}` });
      this.eventLogEl.prepend(li);
      while (this.eventLogEl.childElementCount > 50) {
        this.eventLogEl.removeChild(this.eventLogEl.lastChild);
      }
    }

    this.drawDispatchChart(snapshot.dispatchStack);
    this.drawPriceChart(snapshot.priceHistory);
    this.updateBatteryUI();
  }

  drawDispatchChart(stack) {
    const canvas = $('#dispatch-chart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!stack || !stack.length) {
      ctx.fillStyle = '#666';
      ctx.font = '12px sans-serif';
      ctx.fillText('No data yet', 10, canvas.height / 2);
      return;
    }
    const resources = ['renewables', 'thermal', 'battery'];
    const colors = {
      renewables: '#38b000',
      thermal: '#1f77b4',
      battery: '#f4a259'
    };
    const width = canvas.width / stack.length;
    stack.forEach((hour, index) => {
      let offsetY = canvas.height;
      for (const res of resources) {
        const value = hour[res] || 0;
        const barHeight = (value / stack.max) * (canvas.height - 20);
        ctx.fillStyle = colors[res];
        ctx.fillRect(index * width, offsetY - barHeight, width - 4, barHeight);
        offsetY -= barHeight;
      }
    });
    ctx.fillStyle = '#111';
    ctx.font = '12px sans-serif';
    ctx.fillText('Current Hour Dispatch', 8, 16);
  }

  drawPriceChart(history) {
    const canvas = $('#price-chart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!history || !history.length) {
      ctx.fillStyle = '#666';
      ctx.font = '12px sans-serif';
      ctx.fillText('No data yet', 10, canvas.height / 2);
      return;
    }
    const colors = ['#1b9aaa', '#ef476f', '#ffd166'];
    const zones = this.scenario.zones.map((z, idx) => ({ id: z.id, name: z.name, color: colors[idx % colors.length] }));
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(0, canvas.height - 20);
    ctx.lineTo(canvas.width, canvas.height - 20);
    ctx.stroke();
    const maxPrice = Math.max(100, ...history.flatMap((h) => zones.map((z) => h[z.id] || 0)));
    zones.forEach((zone) => {
      ctx.beginPath();
      history.forEach((tick, idx) => {
        const price = tick[zone.id] || 0;
        const x = (idx / Math.max(1, history.length - 1)) * canvas.width;
        const y = canvas.height - 20 - (price / maxPrice) * (canvas.height - 40);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = zone.color;
      ctx.stroke();
      ctx.fillStyle = zone.color;
      ctx.fillText(zone.name, canvas.width - 70, 20 + 14 * zones.indexOf(zone));
    });
  }

  showFeedback(message) {
    this.feedbackEl.textContent = message;
  }

  updateBatteryUI() {
    const snapshot = this.engine.currentSnapshot();
    if (!snapshot) return;
    const batteryState = snapshot.battery;
    let label = `Battery SOC ${(batteryState.soc * 100).toFixed(0)}%`;
    if (batteryState.mode === 'charge') label += ' (Charging)';
    if (batteryState.mode === 'discharge') label += ' (Discharging)';
    if (batteryState.mode === 'idle') label += ' (Idle)';
    $('#actions').querySelector('fieldset').dataset.status = label;
    $('#actions').querySelector('fieldset').title = label;
  }

  updateActionAvailability() {
    const snapshot = this.engine.currentSnapshot();
    if (!snapshot) return;
    const buttons = $('#unit-actions').querySelectorAll('button');
    buttons.forEach((btn) => {
      const unitId = btn.dataset.unit;
      const unit = snapshot.units.find((u) => u.id === unitId);
      if (!unit) return;
      btn.textContent = `${unit.name} - ${unit.committed ? 'ON' : 'OFF'}`;
      btn.disabled = !unit.toggleAllowed;
      if (!unit.toggleAllowed && unit.toggleReason) {
        btn.title = unit.toggleReason;
      } else {
        btn.title = '';
      }
    });
  }

  showScorecard() {
    const summary = this.engine.computeScore();
    const summaryEl = $('#score-summary');
    summaryEl.innerHTML = `
      <p><strong>Reliability:</strong> ${(summary.reliability * 100).toFixed(1)}%</p>
      <p><strong>Cost Score:</strong> ${(summary.costScore * 100).toFixed(1)}%</p>
      <p><strong>Emissions Score:</strong> ${(summary.emissionsScore * 100).toFixed(1)}%</p>
      <p><strong>Total Score:</strong> ${(summary.total * 100).toFixed(1)}%</p>
    `;
    const badgesEl = $('#score-badges');
    badgesEl.innerHTML = '';
    summary.badges.forEach((badge) => {
      badgesEl.appendChild(createEl('li', { text: badge }));
    });
    $('#scorecard').classList.remove('hidden');
  }

  applyDevOverrides() {
    if (this.engine.running) {
      this.showFeedback('Pause the simulation to apply dev overrides.');
      return;
    }
    const gasInput = $('#dev-gas').value;
    const reserveInput = $('#dev-reserve').value;
    const outageInput = $('#dev-outage').value;
    const txInput = $('#dev-tx').value;
    const gas = gasInput === '' ? NaN : Number(gasInput);
    const reserve = reserveInput === '' ? NaN : Number(reserveInput);
    const outage = outageInput === '' ? NaN : Number(outageInput);
    const tx = txInput === '' ? NaN : Number(txInput);
    this.engine.applyOverrides({ gas, reserve, outage, tx });
    this.feedbackEl.textContent = 'Dev overrides applied.';
  }

  exportCsv() {
    const csv = this.engine.exportCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'power-grid-tycoon-log.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

async function init() {
  try {
    const scenario = await loadScenario();
    const errors = validateScenario(scenario);
    if (errors.length) {
      $('#controls').innerHTML = `<p class="error">Scenario validation failed: ${errors.join(', ')}</p>`;
      return;
    }
    const engine = new SimulationEngine(scenario);
    const ui = new SimulationUI(engine, scenario);
    ui.renderTick(engine.currentSnapshot());
    window.powerGrid = { engine, ui };
    window.runDeterministicTest = async () => {
      const headlessEngine = new SimulationEngine(scenario, { headless: true });
      return headlessEngine.runHeadless();
    };
  } catch (err) {
    $('#controls').innerHTML = `<p class="error">${err.message}</p>`;
  }
}

init();
