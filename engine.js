function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RNG {
  constructor(seed) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.nextGaussian = null;
  }

  next() {
    return this.rand();
  }

  nextRange(min, max) {
    return min + (max - min) * this.next();
  }

  nextInt(min, max) {
    return Math.floor(this.nextRange(min, max + 1));
  }

  normal(mean = 0, std = 1) {
    if (this.nextGaussian !== null) {
      const val = this.nextGaussian;
      this.nextGaussian = null;
      return mean + std * val;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    while (s === 0 || s >= 1) {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    }
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.nextGaussian = v * mul;
    return mean + std * u * mul;
  }
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function formatTime(date) {
  return date.toISOString().substring(11, 16);
}

function capacityFactorFromWind(speed) {
  if (speed <= 3) return 0;
  if (speed < 12) return ((speed - 3) / 9) * 0.9;
  if (speed <= 25) return 0.9;
  return 0;
}

function solarIrradiance(tick, totalTicks, peak) {
  const phase = (tick / totalTicks) * Math.PI * 2;
  const daylight = Math.max(0, Math.sin(phase - Math.PI / 2));
  return Math.min(peak, daylight * peak);
}

function timeOfDayCurve(tick, totalTicks) {
  const dayFraction = tick / totalTicks;
  return 40 * Math.sin(2 * Math.PI * (dayFraction - 0.25));
}

export class SimulationEngine {
  constructor(scenario, options = {}) {
    this.scenario = clone(scenario);
    this.options = options;
    this.tickMinutes = scenario.clock.tickMinutes;
    this.tickHours = this.tickMinutes / 60;
    this.totalTicks = Math.round((scenario.clock.durationHours * 60) / this.tickMinutes);
    this.preRun = true;
    this.running = false;
    this.reset();
  }

  reset() {
    this.rng = new RNG(this.scenario.meta.seed);
    this.state = {
      tickIndex: 0,
      currentTime: new Date(this.scenario.clock.start),
      zones: this.scenario.zones.map((z) => ({ ...clone(z), load: 0, price: 0, renewable: 0, netLoad: 0 })),
      links: this.scenario.transmission.map((t) => ({ ...clone(t), flow: 0, congested: false })),
      thermal: this.scenario.thermalUnits.map((unit) => ({
        ...clone(unit),
        committed: false,
        commandOn: false,
        output: 0,
        outageTicks: 0,
        targetOutput: 0,
        toggleAllowed: true
      })),
      battery: this.initializeBattery(),
      weather: { tempSeries: [], windSeries: [], solarSeries: [] },
      priceHistory: [],
      dispatchHistory: [],
      kpis: {
        unmet: 0,
        avgPrice: 0,
        priceSum: 0,
        priceCount: 0,
        emissions: 0,
        cash: 0,
        energyRevenue: 0,
        fuelExpense: 0,
        vomExpense: 0,
        carbonExpense: 0,
        congestedTicks: 0,
        batteryThroughput: 0,
        loadServed: 0,
        totalLoad: 0
      },
      events: [],
      dayAhead: { quantity: 0, price: this.scenario.meta.dayAheadDefaultPrice, settled: false },
      overrides: {},
      tickLog: [],
      done: false,
      lastEvent: null,
      eventCounter: 0
    };
    this.latestSnapshot = this.buildSnapshot(true);
    this.generateWeatherSeries();
    this.preRun = true;
    this.running = false;
  }

  initializeBattery() {
    const battery = clone(this.scenario.battery);
    const energyCapacity = battery.power * battery.durationHours;
    const initialMWh = energyCapacity * (battery.initialSoc ?? 0.5);
    return {
      ...battery,
      energyCapacity,
      socMWh: initialMWh,
      modeSetting: 'auto',
      mode: 'idle',
      lastActionTick: -1
    };
  }

  generateWeatherSeries() {
    const total = this.totalTicks;
    const tempBase = this.scenario.weather.temperature.base;
    const amplitude = this.scenario.weather.temperature.amplitude;
    const windMean = this.scenario.weather.wind.mean;
    const windVar = this.scenario.weather.wind.variance;
    const solarPeak = this.scenario.weather.solar.peak;
    this.state.weather.tempSeries = new Array(total);
    this.state.weather.windSeries = new Array(total);
    this.state.weather.solarSeries = new Array(total);
    for (let i = 0; i < total; i++) {
      const temp = tempBase + amplitude * Math.sin((2 * Math.PI * i) / total - Math.PI / 2) + this.rng.normal(0, 1.5);
      const wind = Math.max(0, windMean + this.rng.normal(0, Math.sqrt(windVar)));
      const solar = Math.max(0, solarIrradiance(i, total, solarPeak) + this.rng.normal(0, 0.05));
      this.state.weather.tempSeries[i] = temp;
      this.state.weather.windSeries[i] = wind;
      this.state.weather.solarSeries[i] = Math.min(1, solar);
    }
  }

  startRun(contract) {
    if (!this.preRun) throw new Error('Run already started.');
    this.state.dayAhead.quantity = contract.quantity;
    this.state.dayAhead.price = contract.price;
    this.preRun = false;
    this.running = true;
  }

  pause() {
    this.running = false;
  }

  canResume() {
    return !this.preRun && !this.running && !this.state.done;
  }

  resume() {
    if (this.canResume()) {
      this.running = true;
    }
  }

  setBatteryMode(mode) {
    if (!['charge', 'discharge', 'auto'].includes(mode)) return;
    const battery = this.state.battery;
    if (battery.modeSetting === mode) return;
    if ((mode === 'charge' && battery.socMWh >= battery.energyCapacity - 0.01) || (mode === 'discharge' && battery.socMWh <= 0.01)) {
      this.state.lastEvent = { time: formatTime(this.state.currentTime), message: `Battery mode change blocked by SOC limits.` };
      return;
    }
    battery.modeSetting = mode;
  }

  toggleUnit(unitId) {
    const unit = this.state.thermal.find((u) => u.id === unitId);
    if (!unit) {
      return { ok: false, reason: 'Unit not found.' };
    }
    if (unit.outageTicks > 0) {
      return { ok: false, reason: 'Unit is on forced outage.' };
    }
    const previousState = { commandOn: unit.commandOn, committed: unit.committed, output: unit.output };
    unit.commandOn = !unit.commandOn;
    return { ok: true, previousState };
  }

  restoreUnitState(unitId, previous) {
    const unit = this.state.thermal.find((u) => u.id === unitId);
    if (!unit) return;
    Object.assign(unit, previous);
  }

  applyOverrides({ gas, reserve, outage, tx }) {
    if (!Number.isNaN(gas)) {
      this.state.overrides.gas = gas;
    }
    if (!Number.isNaN(reserve)) {
      this.state.overrides.reserve = reserve;
    }
    if (!Number.isNaN(outage)) {
      this.state.overrides.outage = outage;
    }
    if (!Number.isNaN(tx)) {
      this.state.overrides.tx = tx;
      this.state.links.forEach((link) => {
        link.limit = tx;
      });
    }
  }

  applyOutage(unit, currentTime) {
    const multiplier = this.state.overrides.outage || 1;
    const ratePerHour = unit.poissonRate * multiplier;
    const probability = 1 - Math.exp(-ratePerHour * this.tickHours);
    if (unit.outageTicks > 0) {
      unit.outageTicks -= 1;
      if (unit.outageTicks === 0) {
        this.logEvent(`${unit.name} returned from outage.`, currentTime);
      }
      return;
    }
    if (this.rng.next() < probability) {
      const [minHour, maxHour] = unit.repairHours;
      const hours = this.rng.nextRange(minHour, maxHour);
      unit.outageTicks = Math.ceil(hours / this.tickHours);
      this.logEvent(`${unit.name} forced outage for ${hours.toFixed(1)} hours.`, currentTime);
      unit.output = 0;
      unit.committed = false;
      unit.targetOutput = 0;
    }
  }

  logEvent(message, time) {
    const id = this.state.eventCounter++;
    const event = { id, time: formatTime(time), message };
    this.state.events.push(event);
    this.state.lastEvent = event;
  }

  runHeadless() {
    this.startRun({ quantity: 0, price: this.scenario.meta.dayAheadDefaultPrice });
    while (!this.state.done) {
      this.step();
    }
    return this.computeScore();
  }

  step() {
    if (this.state.done) {
      return { ...this.latestSnapshot, done: true };
    }
    if (!this.running && !this.options.headless) {
      return this.latestSnapshot;
    }
    const tickResult = this.executeTick();
    this.latestSnapshot = this.buildSnapshot(false, tickResult);
    if (tickResult.done) {
      this.running = false;
    }
    return this.latestSnapshot;
  }

  executeTick() {
    const idx = this.state.tickIndex;
    if (idx >= this.totalTicks) {
      if (!this.state.done) {
        this.finalizeRun();
      }
      return { done: true };
    }
    const currentTime = new Date(this.state.currentTime);
    const temperature = this.state.weather.tempSeries[idx];
    const wind = this.state.weather.windSeries[idx];
    const solar = this.state.weather.solarSeries[idx];

    const zoneStates = this.state.zones.map((zone) => ({ id: zone.id, name: zone.name, load: 0, price: 0, renewable: 0, netLoad: 0, congestionAdder: 0 }));

    // Load & renewables
    zoneStates.forEach((zoneState) => {
      const zoneConfig = this.scenario.zones.find((z) => z.id === zoneState.id);
      const baseLoad = zoneConfig.baseLoad + timeOfDayCurve(idx, this.totalTicks);
      const tempSensitivity = zoneConfig.tempSensitivity;
      const noise = this.rng.normal(0, 8);
      const load = Math.max(50, baseLoad + tempSensitivity * (temperature - this.scenario.weather.temperature.base) + noise);
      zoneState.load = load;
      const zoneRenewables = this.computeRenewables(zoneState.id, solar, wind);
      zoneState.renewable = zoneRenewables;
      zoneState.netLoad = Math.max(0, load - zoneRenewables);
    });

    const batteryDispatch = this.dispatchBattery(zoneStates);

    // Thermal units ramping & outages
    this.state.thermal.forEach((unit) => {
      this.applyOutage(unit, currentTime);
      if (unit.outageTicks > 0) {
        unit.commandOn = false;
        unit.committed = false;
        unit.output = 0;
      }
    });

    const zoneAllocations = this.dispatchThermal(zoneStates);
    const transmission = this.balanceTransmission(zoneStates, zoneAllocations, batteryDispatch);
    const unmetLoad = zoneStates.reduce((sum, z) => sum + Math.max(0, z.netLoad), 0);

    // Pricing and KPIs
    const reservePercent = (this.state.overrides.reserve ?? this.scenario.meta.reservePercent) / 100;
    zoneStates.forEach((zone) => {
      const requirement = zone.load * reservePercent;
      zone.reserveShort = Math.max(0, requirement - (zoneAllocations[zone.id]?.reserve || 0));
      zone.price = this.computePrice(zone, unmetLoad > 0);
      if (zone.congestionAdder > 0) zone.price += zone.congestionAdder;
      zone.price = Math.min(zone.price, this.scenario.meta.priceCap);
    });

    const priceSample = {};
    zoneStates.forEach((zone) => {
      priceSample[zone.id] = zone.price;
    });
    this.state.priceHistory.push(priceSample);
    if (this.state.priceHistory.length > this.totalTicks) this.state.priceHistory.shift();

    const servedLoad = zoneStates.reduce((sum, zone) => sum + Math.max(0, zone.load - zone.netLoad), 0);

    this.state.kpis.unmet += unmetLoad * this.tickHours;
    this.state.kpis.priceSum += zoneStates.reduce((sum, zone) => sum + zone.price, 0) / zoneStates.length;
    this.state.kpis.priceCount += 1;
    this.state.kpis.totalLoad += zoneStates.reduce((sum, z) => sum + z.load, 0) * this.tickHours;
    this.state.kpis.loadServed += servedLoad * this.tickHours;

    const { fuelExpense, vomExpense, emissions, revenue } = this.computeCosts(zoneStates, zoneAllocations);
    this.state.kpis.cash += revenue - fuelExpense - vomExpense;
    this.state.kpis.energyRevenue += revenue;
    this.state.kpis.fuelExpense += fuelExpense;
    this.state.kpis.vomExpense += vomExpense;
    this.state.kpis.emissions += emissions;

    if (transmission.congested) {
      this.state.kpis.congestedTicks += 1;
    }
    this.state.kpis.batteryThroughput += batteryDispatch.throughput;

    this.state.zones = this.state.zones.map((zone, idx) => ({
      ...zone,
      load: zoneStates[idx].load,
      price: zoneStates[idx].price,
      renewable: zoneStates[idx].renewable,
      netLoad: zoneStates[idx].netLoad,
      congested: zoneStates[idx].congested || false
    }));

    this.recordTickLog(currentTime, zoneStates, transmission, batteryDispatch);

    this.state.tickIndex += 1;
    this.state.currentTime = new Date(currentTime.getTime() + this.tickMinutes * 60000);

    if (this.state.tickIndex >= this.totalTicks) {
      this.finalizeRun();
      return { done: true };
    }
    return { done: false };
  }

  dispatchBattery(zones) {
    const battery = this.state.battery;
    const eff = Math.sqrt(battery.roundTripEff || 0.9);
    let chargeMW = 0;
    let dischargeMW = 0;
    let mode = 'idle';
    const availableCharge = Math.max(0, battery.energyCapacity - battery.socMWh) / this.tickHours;
    const availableDischarge = battery.socMWh / this.tickHours;
    const setMode = battery.modeSetting;
    const anchorZone = zones.find((z) => z.id === battery.zone);
    const netLoadDeviation = anchorZone ? anchorZone.netLoad - anchorZone.load * 0.9 : 0;

    const autoDecision = () => {
      if (!anchorZone) return 'idle';
      if (netLoadDeviation > 20) return 'discharge';
      if (netLoadDeviation < -20) return 'charge';
      return 'idle';
    };

    const desired = setMode === 'auto' ? autoDecision() : setMode;

    if (desired === 'charge' && availableCharge > 0.01) {
      chargeMW = Math.min(battery.power, availableCharge);
      const energyAdded = chargeMW * this.tickHours * eff;
      battery.socMWh = Math.min(battery.energyCapacity, battery.socMWh + energyAdded);
      mode = 'charge';
    } else if (desired === 'discharge' && availableDischarge > 0.01) {
      dischargeMW = Math.min(battery.power, availableDischarge);
      const energyRemoved = dischargeMW * this.tickHours / eff;
      battery.socMWh = Math.max(0, battery.socMWh - energyRemoved);
      mode = 'discharge';
    } else {
      mode = 'idle';
    }

    battery.mode = mode;

    zones.forEach((zone) => {
      if (zone.id === battery.zone) {
        zone.netLoad = Math.max(0, zone.netLoad + chargeMW - dischargeMW);
      }
    });

    return { chargeMW, dischargeMW, mode, throughput: (chargeMW + dischargeMW) * this.tickHours };
  }

  computeRenewables(zoneId, solar, windSpeed) {
    const solarPlants = this.scenario.renewables.solar.filter((s) => s.zone === zoneId);
    const windPlants = this.scenario.renewables.wind.filter((w) => w.zone === zoneId);
    let total = 0;
    solarPlants.forEach((plant) => {
      const daylight = Math.max(0, solar);
      const output = Math.min(plant.pmax, plant.pmax * daylight);
      total += output;
    });
    windPlants.forEach((plant) => {
      const cf = capacityFactorFromWind(windSpeed);
      const output = Math.min(plant.pmax, plant.pmax * cf);
      total += output;
    });
    return total;
  }

  dispatchThermal(zones) {
    const allocations = {};
    const reservePercent = (this.state.overrides.reserve ?? this.scenario.meta.reservePercent) / 100;
    const unitsByZone = {};
    zones.forEach((zone) => {
      allocations[zone.id] = { output: 0, reserve: 0 };
      unitsByZone[zone.id] = this.state.thermal.filter((u) => u.zone === zone.id);
    });

    zones.forEach((zone) => {
      const units = unitsByZone[zone.id].slice().sort((a, b) => this.variableCost(a) - this.variableCost(b));
      const required = zone.netLoad;
      let loadRemaining = required;
      const reserveRequirement = zone.load * reservePercent;
      units.forEach((unit) => {
        const target = this.determineUnitTarget(unit, loadRemaining, reserveRequirement, allocations[zone.id]);
        loadRemaining = Math.max(0, loadRemaining - target.loadServed);
      });
      zone.netLoad = loadRemaining;
    });

    return allocations;
  }

  determineUnitTarget(unit, loadRemaining, reserveRequirement, zoneAllocation) {
    const cost = this.variableCost(unit);
    let loadServed = 0;
    let reserveAdded = 0;
    if (unit.outageTicks > 0) {
      unit.targetOutput = 0;
      unit.toggleAllowed = false;
      unit.toggleReason = 'Outage';
      return { loadServed, reserveAdded };
    }
    unit.toggleAllowed = true;
    unit.toggleReason = '';
    if (!unit.commandOn && unit.output <= 0.001) {
      unit.targetOutput = 0;
      unit.committed = false;
      return { loadServed, reserveAdded };
    }
    const rampUpLimit = unit.output + unit.ramp;
    const rampDownLimit = Math.max(0, unit.output - unit.ramp);
    const maxOutput = Math.min(unit.pmax, rampUpLimit);
    let minOutput = 0;
    if (unit.commandOn) {
      minOutput = Math.min(unit.pmin, maxOutput);
    }
    if (!unit.commandOn) {
      unit.targetOutput = rampDownLimit;
      const contribution = unit.targetOutput;
      loadServed = contribution;
      zoneAllocation.output += contribution;
      return { loadServed, reserveAdded };
    }

    let desired = Math.min(maxOutput, loadRemaining);
    if (desired < minOutput && loadRemaining > 0) desired = Math.min(maxOutput, Math.max(minOutput, loadRemaining));
    unit.targetOutput = desired;
    loadServed = desired;
    reserveAdded = Math.max(0, Math.min(unit.reserveCap, maxOutput - desired));
    zoneAllocation.output += desired;
    zoneAllocation.reserve += reserveAdded;
    return { loadServed, reserveAdded, cost };
  }

  balanceTransmission(zones, allocations, batteryDispatch) {
    const links = this.state.links;
    let congested = false;
    zones.forEach((zone) => {
      zone.netSupply = (allocations[zone.id]?.output || 0) + zone.renewable;
      if (zone.id === this.state.battery.zone) {
        zone.netSupply += batteryDispatch.dischargeMW - batteryDispatch.chargeMW;
      }
      zone.balance = zone.netSupply - zone.load;
    });

    zones.forEach((zone) => {
      zone.congested = false;
      zone.congestionAdder = 0;
    });

    links.forEach((link) => {
      const fromZone = zones.find((z) => z.id === link.from);
      const toZone = zones.find((z) => z.id === link.to);
      let flow = 0;
      if (fromZone.balance > 0 && toZone.balance < 0) {
        flow = Math.min(fromZone.balance, -toZone.balance, link.limit);
        fromZone.balance -= flow;
        toZone.balance += flow;
      } else if (toZone.balance > 0 && fromZone.balance < 0) {
        flow = -Math.min(toZone.balance, -fromZone.balance, link.limit);
        fromZone.balance += -flow;
        toZone.balance -= -flow;
      }
      link.flow = flow;
      link.congested = Math.abs(flow) >= link.limit - 0.01;
      if (link.congested) {
        congested = true;
        const congestionAdder = 15;
        zones.forEach((zone) => {
          if (zone.id === link.from || zone.id === link.to) {
            zone.congested = true;
            zone.congestionAdder = Math.max(zone.congestionAdder, congestionAdder);
          }
        });
      }
    });

    zones.forEach((zone) => {
      zone.netLoad = Math.max(0, -zone.balance);
    });

    return { congested };
  }

  computePrice(zone, loadShed) {
    if (loadShed) {
      return this.scenario.meta.priceCap;
    }
    const zoneUnits = this.state.thermal.filter((u) => u.zone === zone.id);
    let marginalCost = 30;
    zoneUnits.forEach((unit) => {
      if (unit.targetOutput > 0) {
        marginalCost = Math.max(marginalCost, this.variableCost(unit));
      }
    });
    if (zone.congestionAdder) marginalCost += zone.congestionAdder;
    return marginalCost;
  }

  variableCost(unit) {
    const gasOverride = this.state.overrides.gas;
    const fuelPrice = gasOverride ?? unit.fuelPrice;
    return (unit.heatRate * fuelPrice) / 10 + unit.vom;
  }

  computeCosts(zones, allocations) {
    let fuelExpense = 0;
    let vomExpense = 0;
    let emissions = 0;
    let revenue = 0;
    const emissionFactor = (unit) => unit.emissions || 0;
    this.state.thermal.forEach((unit) => {
      const target = unit.targetOutput || 0;
      const actual = this.updateUnitOutput(unit, target);
      const cost = this.variableCost(unit);
      fuelExpense += actual * (cost - unit.vom) * this.tickHours;
      vomExpense += unit.vom * actual * this.tickHours;
      emissions += emissionFactor(unit) * actual * this.tickHours;
    });

    zones.forEach((zone) => {
      const served = Math.max(0, zone.load - zone.netLoad);
      revenue += served * zone.price * this.tickHours;
    });

    return { fuelExpense, vomExpense, emissions, revenue };
  }

  updateUnitOutput(unit, target) {
    const ramp = unit.ramp;
    let newOutput = unit.output;
    if (target > unit.output) {
      newOutput = Math.min(unit.output + ramp, Math.min(unit.pmax, target));
    } else {
      newOutput = Math.max(unit.output - ramp, target);
    }
    if (!unit.commandOn && newOutput <= 0.1) {
      newOutput = 0;
      unit.committed = false;
    } else if (unit.commandOn && newOutput >= unit.pmin - ramp) {
      unit.committed = true;
    }
    unit.output = newOutput;
    return newOutput;
  }

  recordTickLog(time, zones, transmission, batteryDispatch) {
    const entry = {
      timestamp: time.toISOString(),
      temperature: this.state.weather.tempSeries[this.state.tickIndex],
      zones: {},
      battery: {
        soc: this.state.battery.socMWh / this.state.battery.energyCapacity,
        mode: this.state.battery.mode,
        chargeMW: batteryDispatch.chargeMW,
        dischargeMW: batteryDispatch.dischargeMW
      },
      congestion: transmission.congested,
      kpis: {
        unmet: this.state.kpis.unmet,
        cash: this.state.kpis.cash
      }
    };
    zones.forEach((zone) => {
      entry.zones[zone.id] = {
        load: zone.load,
        price: zone.price,
        renewable: zone.renewable,
        netLoad: zone.netLoad,
        congested: zone.congested || false
      };
    });
    this.state.tickLog.push(entry);
  }

  finalizeRun() {
    this.state.done = true;
    const avgPrice = this.state.kpis.priceCount ? this.state.kpis.priceSum / this.state.kpis.priceCount : 0;
    this.state.kpis.avgPrice = avgPrice;
    if (!this.state.dayAhead.settled) {
      const settlement = (this.state.dayAhead.price - avgPrice) * this.state.dayAhead.quantity * this.scenario.clock.durationHours;
      this.state.kpis.cash += settlement;
      this.state.dayAhead.settled = true;
      this.logEvent(`Day ahead contract settled: ${settlement.toFixed(0)}$`, this.state.currentTime);
    }
  }

  currentSnapshot() {
    return this.buildSnapshot(true);
  }

  buildSnapshot(initial = false, tickResult = null) {
    const snapshot = {
      timeLabel: formatTime(this.state.currentTime),
      zones: this.state.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        load: zone.load || 0,
        price: zone.price || 0,
        congested: zone.congested || false
      })),
      links: this.state.links.map((link) => ({ id: link.id, from: link.from, to: link.to, flow: link.flow || 0, limit: link.limit, congested: link.congested || false })),
      kpis: {
        unmet: this.state.kpis.unmet,
        avgPrice: this.state.kpis.priceCount ? this.state.kpis.priceSum / this.state.kpis.priceCount : 0,
        emissions: this.state.kpis.emissions,
        cash: this.state.kpis.cash
      },
      lastEvent: this.state.lastEvent,
      dispatchStack: this.buildDispatchStack(),
      priceHistory: this.state.priceHistory.slice(-this.totalTicks),
      battery: {
        soc: this.state.battery.socMWh / this.state.battery.energyCapacity,
        mode: this.state.battery.modeSetting === 'auto' ? this.state.battery.mode : this.state.battery.modeSetting
      },
      units: this.state.thermal.map((unit) => ({
        id: unit.id,
        name: unit.name,
        committed: unit.commandOn || unit.committed,
        toggleAllowed: unit.outageTicks === 0,
        toggleReason: unit.outageTicks > 0 ? 'Outage' : '',
        output: unit.output
      })),
      done: this.state.done
    };

    if (!initial) {
      const idx = this.state.tickIndex;
      const zones = this.state.zones.map((zone) => zone.id);
      zones.forEach((zoneId) => {
        const latest = this.state.tickLog[this.state.tickLog.length - 1];
        if (latest?.zones?.[zoneId]) {
          const zoneSnap = snapshot.zones.find((z) => z.id === zoneId);
          Object.assign(zoneSnap, {
            load: latest.zones[zoneId].load,
            price: latest.zones[zoneId].price,
            congested: latest.zones[zoneId].congested || false
          });
        }
      });
    }

    return snapshot;
  }

  buildDispatchStack() {
    const ticksPerHour = Math.round(60 / this.tickMinutes);
    const currentHour = Math.floor(this.state.tickIndex / ticksPerHour);
    const startTick = Math.max(0, currentHour * ticksPerHour - ticksPerHour);
    const slice = this.state.tickLog.slice(startTick, startTick + ticksPerHour);
    const totals = slice.reduce(
      (acc, entry) => {
        const renew = Object.values(entry.zones).reduce((sum, z) => sum + z.renewable, 0);
        const load = Object.values(entry.zones).reduce((sum, z) => sum + (z.load - z.netLoad), 0);
        const thermal = Math.max(0, load - renew);
        const battery = entry.battery.dischargeMW * this.tickHours;
        acc.push({ renewables: renew, thermal, battery });
        return acc;
      },
      []
    );
    const max = Math.max(1, ...totals.map((t) => t.renewables + t.thermal + Math.abs(t.battery)));
    totals.max = max;
    return totals;
  }

  computeScore() {
    const weights = this.scenario.meta.scoreWeights;
    const reliability = Math.max(0, 1 - this.state.kpis.unmet / Math.max(1, this.state.kpis.totalLoad));
    const costScore = Math.max(0, Math.min(1, 1 - this.state.kpis.cash / 100000));
    const emissionsScore = Math.max(0, Math.min(1, 1 - this.state.kpis.emissions / 1000));
    const total = reliability * weights.reliability + costScore * weights.cost + emissionsScore * weights.emissions;
    const badges = [];
    if (this.state.kpis.unmet < 0.01) badges.push('Zero Shed Day');
    if (this.state.kpis.congestedTicks < 10) badges.push('Congestion Manager');
    if (this.state.kpis.batteryThroughput > this.state.battery.energyCapacity) badges.push('Battery Hero');
    if (badges.length < 3) badges.push('Market Explorer');
    return { reliability, costScore, emissionsScore, total, badges };
  }

  exportCsv() {
    const header = ['timestamp', 'temperature', 'zone', 'load', 'price', 'renewable', 'netLoad', 'batterySOC', 'batteryMode', 'cash'];
    const rows = [header.join(',')];
    this.state.tickLog.forEach((entry) => {
      Object.entries(entry.zones).forEach(([zoneId, zone]) => {
        rows.push(
          [
            entry.timestamp,
            entry.temperature.toFixed(2),
            zoneId,
            zone.load.toFixed(2),
            zone.price.toFixed(2),
            zone.renewable.toFixed(2),
            zone.netLoad.toFixed(2),
            entry.battery.soc.toFixed(3),
            entry.battery.mode,
            entry.kpis.cash.toFixed(2)
          ].join(',')
        );
      });
    });
    return rows.join('\n');
  }
}
