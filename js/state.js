/*
  Estado y reglas del parqueo.
  Cada estructura se conserva en este archivo para que todas las páginas
  consulten y actualicen los mismos datos guardados en localStorage.
*/
"use strict";

(() => {
  const STORAGE_KEY = "parkflow-beta-v2";
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

  const EXIT_CONFIRMATION_WINDOW = 20 * 60 * 1000;
  const HOURLY_RATES = {
    Automóvil: 5,
    Motocicleta: 3,
    Camioneta: 7,
    SUV: 7,
  };

  // Pila (Stack): cada salida se apila y la última salida se revierte primero.
  let undoStack = [];

  // Arreglo de los últimos movimientos, compartido por todas las páginas.
  let historyEvents = [];
  let layout = DEFAULT_LAYOUT;

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

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

      if (saved && Array.isArray(saved.vehicles)) {
        if (isValidLayout(saved.layout)) {
          layout = saved.layout;
        }
        // Completa atributos nuevos para conservar datos guardados previamente.
        vehicles = saved.vehicles.map((vehicle) => normalizeVehicle(vehicle));
        undoStack = Array.isArray(saved.undoStack)
          ? saved.undoStack.map((vehicle) => normalizeVehicle(vehicle))
          : [];
        historyEvents = Array.isArray(saved.historyEvents)
          ? saved.historyEvents.filter((event) => event.type !== "wait")
          : [];
      }
    } catch (error) {
      console.warn("No se pudo cargar el estado guardado:", error);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      vehicles,
      undoStack,
      historyEvents,
      layout,
    }));
  }

  function getState() {
    expirePayments();
    return { vehicles, departureQueue: vehicles.filter((vehicle) => vehicle.paidAt), undoStack, historyEvents, layout };
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

  function addHistory(type, message, detail = "") {
    historyEvents.unshift({
      type,
      message,
      detail,
      time: new Date().toISOString(),
    });

    historyEvents = historyEvents.slice(0, 50);
  }

  function getStayCharge(vehicle, now = Date.now()) {
    const hourlyRate = HOURLY_RATES[vehicle.type] || HOURLY_RATES.Automóvil;
    const elapsedHours = Math.max(1, Math.ceil((now - new Date(vehicle.enteredAt).getTime()) / (60 * 60 * 1000)));
    return { hourlyRate, elapsedHours, total: hourlyRate * elapsedHours };
  }

  function expirePayments(now = Date.now()) {
    let changed = false;
    vehicles.forEach((vehicle) => {
      if (!vehicle.paidAt || now - new Date(vehicle.paidAt).getTime() < EXIT_CONFIRMATION_WINDOW) return;
      vehicle.paidAt = null;
      vehicle.paidAmount = null;
      addHistory("paymentDue", `${vehicle.plate} requiere un nuevo cobro`, "Venció el plazo de 20 minutos para registrar la salida");
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
    addHistory("entry", `${plate} ingresó al parqueo`, `${vehicle.make} ${vehicle.type} · ${vehicle.color} · ${formatSpace(vehicle)}`);
    window.ParkFlow.showToast(`Ingreso registrado: ${plate}, ${formatSpace(vehicle)}.`);

    saveState();
    window.ParkFlow.render();
    return true;
  }

  function registerPayment(id) {
    expirePayments();
    const vehicle = vehicles.find((item) => item.id === id);
    if (!vehicle || vehicle.paidAt) return;

    const charge = getStayCharge(vehicle);
    vehicle.paidAt = new Date().toISOString();
    vehicle.paidAmount = charge.total;
    addHistory("payment", `${vehicle.plate} pagó Bs ${charge.total}`, `${charge.elapsedHours} h × Bs ${charge.hourlyRate}/h · salida antes de 20 min`);
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(`Pago registrado: Bs ${charge.total}. Confirma la salida en 20 minutos.`);
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

    // Stack LIFO: push registra esta salida para que pop pueda deshacerla.
    undoStack.push({ ...vehicle, exitedAt: new Date().toISOString() });
    addHistory("exit", `${vehicle.plate} salió del parqueo`, `Se liberó ${formatSpace(vehicle)}`);

    const message = `Salida registrada para ${vehicle.plate}.`;

    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(message);
  }

  function undoLastExit() {
    if (!undoStack.length) {
      return;
    }

    // Pila LIFO: pop recupera la última salida guardada.
    const vehicle = undoStack.pop();

    if (indexes().plates.has(vehicle.plate)) {
      undoStack.push(vehicle);
      window.ParkFlow.showToast("No se puede deshacer: la placa ya está activa.");
      return;
    }

    const space = nextFreeSpace();

    if (space === null) {
      undoStack.push(vehicle);
      window.ParkFlow.showToast("No se puede deshacer: el parqueo está lleno.");
      return;
    }

    assignSpace(vehicle, space);
    vehicle.enteredAt = new Date().toISOString();
    vehicle.paidAt = null;
    vehicle.paidAmount = null;
    vehicles.push(vehicle);
    addHistory("entry", `Se revirtió la salida de ${vehicle.plate}`, `${vehicle.make} ${vehicle.type} · ${vehicle.color} · ${formatSpace(vehicle)}`);

    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast(`Se deshizo la última salida de ${vehicle.plate}.`);
  }

  function resetDemo() {
    vehicles = [];
    undoStack = [];
    historyEvents = [];

    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast("La demo se restableció correctamente.");
  }

  function saveLayout(nextLayout) {
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
    saveState();
    window.ParkFlow.render();
    window.ParkFlow.showToast("El plano del parqueo se guardó correctamente.");
    return true;
  }

  loadState();

  window.ParkFlow = {
    get capacity() {
      return getCapacity();
    },
    getState,
    registerVehicle,
    registerPayment,
    releaseVehicle,
    getStayCharge,
    getExitWindow: () => EXIT_CONFIRMATION_WINDOW,
    hourlyRates: HOURLY_RATES,
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
})();
