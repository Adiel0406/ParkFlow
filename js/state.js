/*
  Estado y reglas del parqueo.
  Las reglas del estado viven en este archivo; su persistencia compartida
  se resuelve en la API PostgreSQL asociada al parqueo autenticado.
*/
"use strict";

(() => {
  const DEFAULT_BILLING_INTERVALS = [
    { from: { value: 0, unit: "minutes" }, to: { value: 30, unit: "minutes" }, amount: 2.5 },
    { from: { value: 30, unit: "minutes" }, to: { value: 60, unit: "minutes" }, amount: 2.5 },
    { from: { value: 60, unit: "minutes" }, to: { value: 120, unit: "minutes" }, amount: 5 },
  ];
  const DEFAULT_LAYOUT = {
    floors: [{
      id: "PB",
      label: "Planta baja",
      rows: 3,
      columns: 4,
      cells: Array(12).fill("parking"),
    }],
  };

  // Arreglo: conserva los vehículos que ocupan un espacio en el parqueo.
  // Se recorre para renderizar, buscar y retirar un vehículo activo.
  let vehicles = [];

  const EXIT_CONFIRMATION_WINDOW = 10 * 60 * 1000;
  let billingIntervals = DEFAULT_BILLING_INTERVALS.map((interval) => ({ ...interval }));

  // Pila LIFO para revertir únicamente la salida más reciente.
  let exitStack = [];

  // Arreglo de los últimos movimientos, compartido por todas las páginas.
  let historyEvents = [];
  let layout = DEFAULT_LAYOUT;
  let saveQueue = Promise.resolve();
  let pendingAuditEvents = [];

  function normalizeVehicle(vehicle, defaultFloor = "PB") {
    const normalized = {
      ...vehicle,
      make: vehicle.make || "No especificada",
      color: vehicle.color || "No especificado",
      floorId: vehicle.floorId || (vehicle.slot ? defaultFloor : null),
    };

    if (normalized.slot && normalized.row === undefined) {
      const floor = layout.floors.find((item) => item.id === normalized.floorId);
      const columns = floor?.columns || 4;
      normalized.row = Math.floor((normalized.slot - 1) / columns);
      normalized.column = (normalized.slot - 1) % columns;
    }

    return normalized;
  }

  function isValidLayout(value) {
    const tileTypes = new Set(["parking", "aisle", "entrance", "ramp", "circularRamp", "empty"]);

    if (!value || !Array.isArray(value.floors) || value.floors.length === 0 || value.floors.length > 15) {
      return false;
    }

    const validFloors = value.floors.every((floor) =>
        floor
        && typeof floor.id === "string"
        && /^(?:S[1-5]|PB|P[1-9])$/.test(floor.id)
        && floor.label === (floor.id === "PB"
          ? "Planta baja"
          : floor.id.startsWith("S")
            ? `Subsuelo ${floor.id.slice(1)}`
            : `Piso ${floor.id.slice(1)}`)
        && Number.isInteger(floor.rows)
        && Number.isInteger(floor.columns)
        && floor.rows > 0
        && floor.rows <= 20
        && floor.columns > 0
        && floor.columns <= 20
        && Array.isArray(floor.cells)
        && floor.cells.length === floor.rows * floor.columns
        && floor.cells.every((type) => tileTypes.has(type)));

    return validFloors
      && value.floors.some((floor) => floor.id === "PB")
      && new Set(value.floors.map((floor) => floor.id)).size === value.floors.length;
  }

  function getParkingSpaces() {
    let slot = 0;
    const spaces = [];

    layout.floors.forEach((floor) => {
      floor.cells.forEach((type, index) => {
        if (type !== "parking") return;
        slot += 1;
        spaces.push({
          slot,
          floorId: floor.id,
          row: Math.floor(index / floor.columns),
          column: index % floor.columns,
        });
      });
    });

    return spaces;
  }

  function getCapacity() {
    return getParkingSpaces().length;
  }

  function formatSpace(vehicle) {
    const floor = layout.floors.find((item) => item.id === vehicle.floorId);
    const floorLabel = floor ? floor.label : "Planta baja";
    return `${floorLabel} · P-${String(vehicle.slot).padStart(2, "0")}`;
  }

  async function loadStateFromServer() {
    const response = await fetch("/api/parking/state", { credentials: "same-origin" });
    if (!response.ok) throw new Error("No se pudo cargar el estado del parqueo.");
    const { state: saved } = await response.json();
    if (isValidLayout(saved.layout)) layout = saved.layout;
    vehicles = Array.isArray(saved.vehicles) ? saved.vehicles.map((vehicle) => normalizeVehicle(vehicle)) : [];
    exitStack = Array.isArray(saved.exitStack) ? saved.exitStack.map((vehicle) => normalizeVehicle(vehicle)) : [];
    historyEvents = Array.isArray(saved.historyEvents) ? saved.historyEvents.filter((event) => event.type !== "wait") : [];
    if (isValidBillingIntervals(saved.billingIntervals)) {
      billingIntervals = saved.billingIntervals.map((interval) => ({
        ...interval,
        from: { ...interval.from },
        to: { ...interval.to },
      }));
    }
  }

  function saveState() {
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const eventBatch = pendingAuditEvents.slice();
      const response = await fetch("/api/parking/state", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicles,
          exitStack,
          historyEvents,
          layout,
          billingIntervals,
          auditEvents: eventBatch.map((event) => ({
            eventType: event.type,
            message: event.message,
            detail: event.detail,
            metadata: event.metadata,
          })),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "No se pudo guardar el parqueo.");
      }
      pendingAuditEvents.splice(0, eventBatch.length);
    }).catch((error) => {
      console.error("No se pudo guardar el estado del parqueo:", error);
      window.ParkFlow.showToast("No se pudo guardar en el servidor. Revisa la conexión y vuelve a intentar.");
    });
    return saveQueue;
  }

  function getState() {
    expirePayments();
    return {
      vehicles,
      departureQueue: vehicles.filter((vehicle) => vehicle.paidAt),
      exitStack,
      historyEvents,
      layout,
      billingIntervals: billingIntervals.map((interval) => ({
        from: { ...interval.from },
        to: { ...interval.to },
        amount: interval.amount,
      })),
    };
  }

  function isValidBillingIntervals(intervals) {
    if (!Array.isArray(intervals) || intervals.length === 0) return false;

    return intervals.every((interval, index) => {
      if (!interval
        || !interval.from
        || !interval.to
        || !Number.isFinite(interval.from.value)
        || !Number.isFinite(interval.to.value)
        || !["minutes", "hours"].includes(interval.from.unit)
        || !["minutes", "hours"].includes(interval.to.unit)
        || !Number.isFinite(interval.amount)
        || interval.amount < 0) return false;

      const startMinutes = interval.from.value * (interval.from.unit === "hours" ? 60 : 1);
      const endMinutes = interval.to.value * (interval.to.unit === "hours" ? 60 : 1);
      if (startMinutes < 0 || endMinutes <= startMinutes) return false;
      if (index === 0) return startMinutes === 0;

      const previous = intervals[index - 1];
      const previousEndMinutes = previous.to.value * (previous.to.unit === "hours" ? 60 : 1);
      return Math.abs(startMinutes - previousEndMinutes) < 1e-9;
    });
  }

  function normalizePlate(value) {
    return value.trim().toUpperCase();
  }

  function indexes() {
    // Map permite consultar si una placa ya está activa.
    const vehicleByPlate = new Map();

    vehicles.forEach((vehicle) => {
      vehicleByPlate.set(vehicle.plate, vehicle);
    });

    return vehicleByPlate;
  }

  function nextFreeSpace() {
    // Tabla hash: Map permite consultar vehículos por el número de espacio.
    const vehicleBySlot = new Map(vehicles.map((vehicle) => [vehicle.slot, vehicle]));
    return getParkingSpaces().find((space) => !vehicleBySlot.has(space.slot)) || null;
  }

  function assignSpace(vehicle, space) {
    vehicle.slot = space.slot;
    vehicle.floorId = space.floorId;
    vehicle.row = space.row;
    vehicle.column = space.column;
  }

  function addHistory(type, message, detail = "", metadata = {}) {
    const event = {
      type,
      message,
      detail,
      time: new Date().toISOString(),
      metadata,
    };
    historyEvents.unshift(event);

    historyEvents = historyEvents.slice(0, 50);
    pendingAuditEvents.push(event);
  }

  function getStayCharge(vehicle, now = Date.now()) {
    const elapsedMinutes = Math.max(0, (now - new Date(vehicle.enteredAt).getTime()) / 60000);
    const intervalIndex = billingIntervals.findIndex((interval) => {
      const endMinutes = interval.to.value * (interval.to.unit === "hours" ? 60 : 1);
      return elapsedMinutes <= endMinutes;
    });
    const selectedIndex = intervalIndex < 0 ? billingIntervals.length - 1 : intervalIndex;
    const selectedInterval = billingIntervals[selectedIndex];
    const formatBoundary = ({ value, unit }) => `${value} ${unit === "hours" ? "h" : "min"}`;
    const label = `De ${formatBoundary(selectedInterval.from)} hasta ${formatBoundary(selectedInterval.to)}`;

    return {
      elapsedMinutes,
      billableMinutes: elapsedMinutes,
      total: selectedInterval.amount,
      intervalCharges: [{
        label: elapsedMinutes > selectedInterval.to.value * (selectedInterval.to.unit === "hours" ? 60 : 1)
          ? `${label} (tarifa extendida)`
          : label,
        durationMinutes: elapsedMinutes,
        amount: selectedInterval.amount,
      }],
    };
  }

  function saveTariffConfig(intervals) {
    if (!window.ParkFlowAuth?.canManageTariff()) {
      window.ParkFlow?.showToast("Tu cargo no permite modificar el tarifario.");
      return false;
    }
    if (!isValidBillingIntervals(intervals)) {
      window.ParkFlow.showToast("Los intervalos deben empezar en 0, tener límites crecientes y continuos, unidades válidas y montos no negativos.");
      return false;
    }

    billingIntervals = intervals.map((interval) => ({
      from: { value: Number(interval.from.value), unit: interval.from.unit },
      to: { value: Number(interval.to.value), unit: interval.to.unit },
      amount: Number(interval.amount),
    }));
    addHistory("tariff", "Se actualizó el tarifario", `${billingIntervals.length} intervalos de cobro`, { billingIntervals });
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast("El tarifario y sus intervalos se guardaron correctamente.");
    return true;
  }

  function expirePayments(now = Date.now()) {
    let changed = false;
    vehicles.forEach((vehicle) => {
      if (!vehicle.paidAt || now - new Date(vehicle.paidAt).getTime() < EXIT_CONFIRMATION_WINDOW) return;
      const expiredPayment = { paidAt: vehicle.paidAt, paidAmount: vehicle.paidAmount };
      vehicle.paidAt = null;
      vehicle.paidAmount = null;
      addHistory("paymentDue", `${vehicle.plate} requiere un nuevo cobro`, "Venció el plazo de 10 minutos para registrar la salida", { plate: vehicle.plate, ...expiredPayment });
      changed = true;
    });
    if (changed) saveState();
  }

  function registerVehicle(data) {
    const plate = normalizePlate(data.plate);

    if (!/^(?:\d{4}|\d{5})-[A-Z]{3}$/.test(plate)) {
      window.ParkFlow.showToast("Placa inválida. Usa 4 o 5 números, un guion y 3 letras; por ejemplo, 4582-ABC.");
      document.querySelector("#plate")?.focus();
      return false;
    }

    const make = String(data.make || "").trim();
    const color = String(data.color || "").trim();

    if (!make || !color) {
      window.ParkFlow.showToast("Selecciona la marca y el color del vehículo.");
      return false;
    }

    const vehicleByPlate = indexes();

    if (vehicleByPlate.has(plate)) {
      window.ParkFlow.showToast("Esa placa ya está registrada en el parqueo.");
      document.querySelector("#plate")?.focus();
      return false;
    }

    const space = nextFreeSpace();
    if (space === null) {
      window.ParkFlow.showToast("El parqueo está lleno. No se registró el ingreso.");
      return false;
    }

    const vehicle = {
      id: globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
      plate,
      type: data.type,
      make,
      color,
      enteredAt: new Date().toISOString(),
      slot: null,
    };

    assignSpace(vehicle, space);
    vehicles.push(vehicle);
    addHistory("entry", `${plate} ingresó al parqueo`, `${vehicle.make} ${vehicle.type} · ${vehicle.color} · ${formatSpace(vehicle)}`, { vehicle });
    window.ParkFlow.showToast(`Ingreso registrado: ${plate}, ${formatSpace(vehicle)}.`);

    saveState();
    window.ParkFlow.render();
    return true;
  }

  function createInvoice(id) {
    expirePayments();
    const vehicle = vehicles.find((item) => item.id === id);
    if (!vehicle || vehicle.paidAt) return null;

    const charge = getStayCharge(vehicle);
    return {
      vehicleId: vehicle.id,
      plate: vehicle.plate,
      make: vehicle.make,
      type: vehicle.type,
      color: vehicle.color,
      enteredAt: vehicle.enteredAt,
      elapsedMinutes: charge.elapsedMinutes,
      billableMinutes: charge.billableMinutes,
      total: charge.total,
      intervalCharges: charge.intervalCharges,
    };
  }

  function confirmPayment(id, expectedAmount, customer = {}) {
    expirePayments();
    const vehicle = vehicles.find((item) => item.id === id);
    if (!vehicle) {
      window.ParkFlow.showToast("No se encontró el vehículo para confirmar el cobro.");
      return false;
    }
    if (vehicle.paidAt) {
      window.ParkFlow.showToast("El vehículo ya tiene un cobro registrado.");
      return false;
    }

    const charge = getStayCharge(vehicle);
    if (charge.total !== expectedAmount) {
      window.ParkFlow.showToast("El importe de la factura cambió. Revisa la factura actualizada antes de cobrar.");
      return false;
    }

    const paidAt = new Date().toISOString();
    vehicle.paidAt = paidAt;
    vehicle.paidAmount = charge.total;
    vehicle.invoiceCustomer = {
      nit: String(customer.nit || "").trim(),
      name: String(customer.name || "").trim(),
      email: String(customer.email || "").trim(),
    };
    addHistory("payment", `${vehicle.plate} pagó Bs ${charge.total}`, `${charge.billableMinutes.toFixed(1)} min facturados · salida antes de 10 min`, {
      vehicle,
      amount: charge.total,
      billableMinutes: charge.billableMinutes,
      customer: vehicle.invoiceCustomer,
      intervalCharges: charge.intervalCharges,
    });
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(`Pago registrado: Bs ${charge.total}. Confirma la salida en 10 minutos.`);
    return true;
  }

  function releaseVehicle(id) {
    expirePayments();
    const vehicleIndex = vehicles.findIndex((vehicle) => vehicle.id === id);

    if (vehicleIndex < 0) {
      return;
    }

    if (!vehicles[vehicleIndex].paidAt) {
      window.ParkFlow.showToast("Primero debes cobrar la estadía del vehículo.");
      return;
    }

    const [vehicle] = vehicles.splice(vehicleIndex, 1);

    // Stack LIFO: conserva el vehículo pagado para revertir esta salida.
    exitStack.push({ ...vehicle, exitedAt: new Date().toISOString() });
    addHistory("exit", `${vehicle.plate} salió del parqueo`, `Se liberó ${formatSpace(vehicle)}`, { vehicle });

    const message = `Salida registrada para ${vehicle.plate}.`;

    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(message);
  }

  function undoLastExit() {
    if (!exitStack.length) return;

    const vehicle = exitStack.pop();
    if (indexes().has(vehicle.plate)) {
      exitStack.push(vehicle);
      window.ParkFlow.showToast("No se puede deshacer: la placa ya está activa.");
      return;
    }

    const occupiedSlots = new Set(vehicles.map((item) => item.slot));
    const originalSpace = getParkingSpaces().find((space) =>
      space.slot === vehicle.slot && !occupiedSlots.has(space.slot));
    const space = originalSpace || nextFreeSpace();
    if (!space) {
      exitStack.push(vehicle);
      window.ParkFlow.showToast("No se puede deshacer: el parqueo está lleno.");
      return;
    }

    delete vehicle.exitedAt;
    assignSpace(vehicle, space);
    vehicles.push(vehicle);
    const remaining = Math.max(0, EXIT_CONFIRMATION_WINDOW - (Date.now() - new Date(vehicle.paidAt).getTime()));
    const remainingMinutes = Math.ceil(remaining / 60000);
    addHistory("exitUndone", `Se revirtió la salida de ${vehicle.plate}`, `Se conservó el pago de Bs ${vehicle.paidAmount} y el tiempo restante (${remainingMinutes} min) · ${formatSpace(vehicle)}`, { vehicle });

    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(`Se revirtió la salida de ${vehicle.plate}. Se mantiene el tiempo restante para confirmar.`);
  }

  function resetDemo() {
    const resetCount = vehicles.length;
    vehicles = [];
    exitStack = [];
    historyEvents = [];

    addHistory("reset", "Se reinició la demo del parqueo", `${resetCount} vehículos activos eliminados de la vista operativa`, { removedVehicles: resetCount });
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast("La demo se restableció correctamente.");
  }

  function saveLayout(nextLayout) {
    if (!window.ParkFlowAuth?.canManageLayout()) {
      window.ParkFlow?.showToast("Solo el administrador puede modificar el parqueo.");
      return false;
    }
    if (vehicles.length) {
      window.ParkFlow.showToast("Registra la salida de todos los vehículos antes de cambiar el plano.");
      return false;
    }

    if (!isValidLayout(nextLayout)) {
      window.ParkFlow.showToast("El plano no es válido. Revisa los pisos y las dimensiones.");
      return false;
    }

    layout = {
      floors: nextLayout.floors.map((floor) => ({
        ...floor,
        cells: floor.cells.slice(),
      })),
    };
    addHistory("layout", "Se modificó el diseño del parqueo", `${layout.floors.length} pisos configurados`, { layout });
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast("El plano del parqueo se guardó correctamente.");
    return true;
  }

  window.ParkFlow = {
    get capacity() {
      return getCapacity();
    },
    getState,
    registerVehicle,
    releaseVehicle,
    getStayCharge,
    getExitWindow: () => EXIT_CONFIRMATION_WINDOW,
    createInvoice,
    confirmPayment,
    get billingIntervals() {
      return billingIntervals.map((interval) => ({
        from: { ...interval.from },
        to: { ...interval.to },
        amount: interval.amount,
      }));
    },
    saveTariffConfig,
    undoLastExit,
    resetDemo,
    saveLayout,
    getParkingSpaces,
    formatSpace,
    render: () => {},
    showToast: (message) => {
      const toast = document.querySelector("#toast");
      if (toast) {
        toast.textContent = message;
        toast.classList.add("show");
        window.clearTimeout(toast.timer);
        toast.timer = window.setTimeout(() => toast.classList.remove("show"), 2800);
      }
    },
  };

  window.ParkFlow.ready = loadStateFromServer().then(() => {
    window.ParkFlow.render();
    return true;
  }).catch((error) => {
    console.error("No se pudo inicializar el parqueo:", error);
    return false;
  });
})();
