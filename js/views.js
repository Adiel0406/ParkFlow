/*
  Funciones que presentan el estado compartido en las páginas HTML.
  El arreglo que aparece en la tabla se filtra y se ordena en una copia:
  así se muestra por espacio y placa sin modificar el arreglo original.
*/
"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("es-BO", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    }).format(new Date(value));
  }

  function renderStats(state) {
    const totalVehicles = state.vehicles.length;
    const capacity = window.ParkFlow.capacity;
    const freeSpaces = Math.max(0, capacity - totalVehicles);
    const occupancy = capacity ? Math.round((totalVehicles / capacity) * 100) : 0;

    if ($("#occupiedStat")) {
      $("#occupiedStat").innerHTML = `${totalVehicles} <small>/ ${capacity}</small>`;
    }
    if ($("#availableStat")) $("#availableStat").textContent = freeSpaces;
    if ($("#totalStat")) $("#totalStat").textContent = totalVehicles;
    if ($("#queueStat")) $("#queueStat").textContent = state.departureQueue.length;
    if ($("#queueBadge")) $("#queueBadge").textContent = state.departureQueue.length;
    if ($("#occupancyText")) $("#occupancyText").textContent = `${occupancy}% de ocupación`;
    if ($("#occupancyBar")) $("#occupancyBar").style.width = `${occupancy}%`;
    if ($("#freeLabel")) $("#freeLabel").textContent = `${freeSpaces} libres`;
    if ($("#freeLabelFooter")) $("#freeLabelFooter").textContent = `${freeSpaces} libres`;
    if ($("#capacityLabel")) {
      $("#capacityLabel").textContent = `${capacity} espacios`;
    }
    if ($("#undoExit")) $("#undoExit").disabled = !state.undoStack.length;
  }

  function renderParkingGrid(state) {
    const grid = $("#parkingGrid");
    if (!grid) return;

    // Tabla hash: Map relaciona cada espacio configurable con su vehículo.
    const vehicleBySlot = new Map(state.vehicles.map((vehicle) => [vehicle.slot, vehicle]));
    const tileLabels = {
      aisle: ["Pasillo", "↕"],
      entrance: ["Entrada", "⇧"],
      ramp: ["Rampa", "↗"],
      circularRamp: ["Rampa circular", "↻"],
      empty: ["Sin asignar", "·"],
    };
    let slot = 0;

    grid.innerHTML = state.layout.floors.map((floor) => {
      const cells = floor.cells.map((type, index) => {
        if (type !== "parking") {
          const [label, symbol] = tileLabels[type] || tileLabels.empty;
          return `
            <div class="parking-map-cell cell-${escapeHtml(type)}" title="${label}">
              <span class="map-cell-symbol" aria-hidden="true">${symbol}</span>
              <span>${label}</span>
            </div>
          `;
        }

        slot += 1;
        const vehicle = vehicleBySlot.get(slot);
        const space = {
          slot,
          floorId: floor.id,
          row: Math.floor(index / floor.columns),
          column: index % floor.columns,
        };
        const title = vehicle
          ? `Ocupado por ${escapeHtml(vehicle.plate)}`
          : `Disponible: ${window.ParkFlow.formatSpace(space)}`;

        return `
          <div class="parking-map-cell parking-slot ${vehicle ? "occupied" : ""}" title="${title}">
            <span class="map-cell-symbol" aria-hidden="true">${vehicle ? (vehicle.type === "Motocicleta" ? "🏍️" : "🚙") : "P"}</span>
            <strong>P-${String(slot).padStart(2, "0")}</strong>
            <span>${vehicle ? escapeHtml(vehicle.plate) : "Disponible"}</span>
          </div>
        `;
      }).join("");

      return `
        <section class="parking-floor-map">
          <h3>${escapeHtml(floor.label)} <small>${floor.rows} × ${floor.columns}</small></h3>
          <div class="parking-floor-grid" style="--columns: ${floor.columns}">
            ${cells}
          </div>
        </section>
      `;
    }).join("");
  }

  function renderQueue(state) {
    const list = $("#queueList");
    if (!list) return;

    if (!state.departureQueue.length) {
      list.innerHTML = '<div class="empty-state">No hay vehículos pagados pendientes de confirmar su salida.</div>';
      return;
    }

    list.innerHTML = state.departureQueue.map((vehicle) => {
      const remaining = Math.max(0, window.ParkFlow.getExitWindow() - (Date.now() - new Date(vehicle.paidAt).getTime()));
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      return `
      <article class="queue-item">
        <div class="queue-order">PENDIENTE DE SALIDA · ${minutes}:${String(seconds).padStart(2, "0")}</div>
        <div class="queue-plate">${escapeHtml(vehicle.plate)}</div>
        <div class="queue-meta">${escapeHtml(vehicle.make)} · ${escapeHtml(vehicle.type)} · ${escapeHtml(vehicle.color)}</div>
        <div class="queue-meta">Pagó Bs ${escapeHtml(vehicle.paidAmount)}</div>
      </article>
      `;
    }).join("");
  }

  function renderTable(state) {
    const tableBody = $("#vehicleTable");
    if (!tableBody) return;

    const searchText = $("#searchInput")?.value.trim().toLowerCase() || "";
    const selectedType = $("#typeFilter")?.value || "";

    // Arreglo ordenado: filtra y ordena una copia por espacio y luego por placa.
    const orderedVehicles = state.vehicles
      .filter((vehicle) => {
        const searchableText = `${vehicle.plate} ${vehicle.make} ${vehicle.color} ${vehicle.type}`.toLowerCase();
        return searchableText.includes(searchText) && (!selectedType || vehicle.type === selectedType);
      })
      .slice()
      .sort((first, second) => first.slot - second.slot || first.plate.localeCompare(second.plate));

    tableBody.innerHTML = orderedVehicles.length
      ? orderedVehicles.map((vehicle) => {
          const charge = window.ParkFlow.getStayCharge(vehicle);
          const action = vehicle.paidAt
            ? `<button class="btn btn-exit" type="button" data-exit="${escapeHtml(vehicle.id)}">Confirmar salida</button>`
            : `<button class="btn btn-primary" type="button" data-pay="${escapeHtml(vehicle.id)}">Cobrar Bs ${charge.total}</button>`;
          const status = vehicle.paidAt
            ? `Pagado · ${Math.max(0, Math.ceil((window.ParkFlow.getExitWindow() - (Date.now() - new Date(vehicle.paidAt).getTime())) / 60000))} min para salir`
            : `Pendiente · Bs ${charge.hourlyRate}/h`;
          return `
          <tr>
            <td class="plate-cell">${escapeHtml(vehicle.plate)}</td>
            <td>${escapeHtml(vehicle.make)}</td>
            <td>${escapeHtml(vehicle.color)}</td>
            <td><span class="type-tag">${escapeHtml(vehicle.type)}</span></td>
            <td><span class="slot-tag">${escapeHtml(window.ParkFlow.formatSpace(vehicle))}</span></td>
            <td>${formatTime(vehicle.enteredAt)}</td>
            <td>${status}</td>
            <td>${action}</td>
          </tr>
        `;
        }).join("")
      : `<tr><td colspan="8" class="table-empty">${state.vehicles.length ? "No se encontraron coincidencias." : "Todavía no hay vehículos registrados."}</td></tr>`;

    if ($("#tableCount")) {
      const count = state.vehicles.length;
      $("#tableCount").textContent = `${count} vehículo${count === 1 ? "" : "s"} activo${count === 1 ? "" : "s"}`;
    }
  }

  function renderHistory(state) {
    const historyList = $("#historyList");
    if (!historyList) return;

    const events = state.historyEvents.slice(0, 8);

    historyList.innerHTML = events.length
      ? events.map((event) => {
          const kind = event.type === "exit" ? "exit" : event.type === "paymentDue" ? "wait" : "";
          const symbol = event.type === "exit" ? "↙" : event.type === "payment" ? "Bs" : event.type === "paymentDue" ? "!" : "↗";

          return `
            <div class="history-row">
              <span class="history-mark ${kind}">${symbol}</span>
              <div>
                <div class="history-message">${escapeHtml(event.message)}</div>
                <div class="history-detail">${escapeHtml(event.detail)}</div>
              </div>
              <time class="history-time">${formatTime(event.time)}</time>
            </div>
          `;
        }).join("")
      : '<div class="empty-state">Todavía no hay movimientos registrados.</div>';
  }

  function render() {
    const state = window.ParkFlow.getState();

    renderStats(state);
    renderParkingGrid(state);
    renderQueue(state);
    renderTable(state);
    renderHistory(state);
  }

  window.ParkFlow.render = render;
})();
