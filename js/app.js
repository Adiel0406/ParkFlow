/*
  Conecta los controles disponibles en la página actual con las acciones
  del estado. Las búsquedas por selector evitan asumir que cada página
  contiene todos los componentes de las demás.
*/
"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);

  const THEME_STORAGE_KEY = "parkflow-theme";

  function updateThemeButton(button, isDark) {
    button.setAttribute("aria-pressed", String(isDark));
    button.querySelector(".theme-toggle-icon").textContent = isDark ? "☀" : "☾";
    button.querySelector(".theme-toggle-label").textContent = isDark
      ? "Modo claro"
      : "Modo oscuro";
    button.setAttribute(
      "aria-label",
      isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro",
    );
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    const isDark = document.documentElement.dataset.theme === "dark";
    updateThemeButton(button, isDark);

    button.addEventListener("click", () => {
      const enableDarkTheme = document.documentElement.dataset.theme !== "dark";
      document.documentElement.dataset.theme = enableDarkTheme ? "dark" : "light";
      updateThemeButton(button, enableDarkTheme);

      try {
        localStorage.setItem(THEME_STORAGE_KEY, enableDarkTheme ? "dark" : "light");
      } catch (error) {
        console.warn("No se pudo guardar la preferencia del tema:", error);
      }
    });
  });

  const vehicleForm = $("#vehicleForm");
  if (vehicleForm) {
    const makeSelect = $("#vehicleMake");
    const otherMakeInput = $("#otherVehicleMake");

    const updateOtherMakeField = () => {
      const needsCustomMake = makeSelect.value === "Otra";
      otherMakeInput.hidden = !needsCustomMake;
      otherMakeInput.required = needsCustomMake;

      if (!needsCustomMake) {
        otherMakeInput.value = "";
      }
    };

    makeSelect?.addEventListener("change", () => {
      updateOtherMakeField();
      if (!otherMakeInput.hidden) {
        otherMakeInput.focus();
      }
    });

    vehicleForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const formData = new FormData(vehicleForm);
      const selectedMake = formData.get("vehicleMake");
      const registered = window.ParkFlow.registerVehicle({
        plate: formData.get("plate"),
        type: formData.get("vehicleType"),
        make: selectedMake === "Otra"
          ? formData.get("otherVehicleMake")
          : selectedMake,
        color: formData.get("vehicleColor"),
      });

      if (registered) {
        vehicleForm.reset();
        updateOtherMakeField();
      }
    });
  }

  const vehicleTable = $("#vehicleTable");
  let pendingInvoice = null;

  function updateInvoice(invoice) {
    pendingInvoice = invoice;
    $("#invoicePlate").textContent = invoice.plate;
    $("#invoiceVehicle").textContent = `${invoice.make} · ${invoice.type} · ${invoice.color}`;
    $("#invoiceEntryTime").textContent = new Intl.DateTimeFormat("es-BO", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(invoice.enteredAt));
    $("#invoiceElapsed").textContent = `${Math.ceil(invoice.elapsedMinutes)} min`;
    $("#invoiceBillingTime").textContent = `${invoice.billableMinutes.toFixed(1)} min`;
    $("#invoiceTotal").textContent = `Bs ${invoice.total.toFixed(2)}`;
    $("#invoiceBreakdown").innerHTML = invoice.intervalCharges.map((charge) => {
      return `<li>${charge.label} · Bs ${charge.amount.toFixed(2)}</li>`;
    }).join("");
  }

  function requestInvoiceCancellation() {
    const confirmation = $("#cancelInvoiceDialog");
    if (confirmation?.showModal) confirmation.showModal();
  }

  if (vehicleTable) {
    vehicleTable.addEventListener("click", (event) => {
      const target = event.target;
      const exitButton = target instanceof Element ? target.closest("[data-exit]") : null;
      const paymentButton = target instanceof Element ? target.closest("[data-pay]") : null;

      if (paymentButton) {
        const invoice = window.ParkFlow.createInvoice(paymentButton.dataset.pay);
        if (invoice) {
          $("#invoiceCustomerNit").value = "";
          $("#invoiceCustomerName").value = "";
          $("#invoiceCustomerEmail").value = "";
          updateInvoice(invoice);
          $("#invoiceDialog")?.showModal();
        }
      } else if (exitButton) {
        window.ParkFlow.releaseVehicle(exitButton.dataset.exit);
      }
    });
  }

  $("#searchInput")?.addEventListener("input", window.ParkFlow.render);
  $("#typeFilter")?.addEventListener("change", window.ParkFlow.render);
  $("#undoExit")?.addEventListener("click", window.ParkFlow.undoLastExit);

  $("#tariffForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formIntervals = [...event.currentTarget.querySelectorAll(".interval-row")].map((row) => ({
      from: {
        value: Number(row.querySelector("[data-interval-from]").value),
        unit: row.querySelector("[data-interval-from-unit]").value,
      },
      to: {
        value: Number(row.querySelector("[data-interval-to]").value),
        unit: row.querySelector("[data-interval-to-unit]").value,
      },
      amount: Number(row.querySelector("[data-interval-amount]").value),
    }));
    window.ParkFlow.saveTariffConfig(formIntervals);
  });

  const intervalList = $("#intervalList");
  if (intervalList) {
    let draftIntervals = window.ParkFlow.getState().billingIntervals.map((interval) => ({
      from: { ...interval.from },
      to: { ...interval.to },
      amount: interval.amount,
    }));

    function convertBoundaryValue(value, fromUnit, toUnit) {
      const minutes = value * (fromUnit === "hours" ? 60 : 1);
      return Number((minutes / (toUnit === "hours" ? 60 : 1)).toFixed(6));
    }

    function readDraftIntervals() {
      draftIntervals = [...intervalList.querySelectorAll(".interval-row")].map((row) => ({
        from: {
          value: Number(row.querySelector("[data-interval-from]").value),
          unit: row.querySelector("[data-interval-from-unit]").value,
        },
        to: {
          value: Number(row.querySelector("[data-interval-to]").value),
          unit: row.querySelector("[data-interval-to-unit]").value,
        },
        amount: Number(row.querySelector("[data-interval-amount]").value),
      }));
    }

    function syncIntervalStarts() {
      draftIntervals[0].from = { value: 0, unit: "minutes" };
      for (let index = 1; index < draftIntervals.length; index += 1) {
        const previousEnd = draftIntervals[index - 1].to;
        const unit = draftIntervals[index].from.unit;
        draftIntervals[index].from = {
          value: convertBoundaryValue(previousEnd.value, previousEnd.unit, unit),
          unit,
        };
      }
    }

    function renderIntervals() {
      syncIntervalStarts();
      intervalList.innerHTML = draftIntervals.map((interval, index) => `
          <div class="interval-row">
            <strong>Intervalo ${index + 1}</strong>
            <div class="interval-field interval-boundary">
              <label for="interval-from-${index}">De</label>
              <input id="interval-from-${index}" type="number" min="0" step="any" value="${interval.from.value}" data-interval-from readonly required>
              <select data-interval-from-unit aria-label="Unidad del inicio del intervalo ${index + 1}">
                <option value="minutes" ${interval.from.unit === "minutes" ? "selected" : ""}>Minutos</option>
                <option value="hours" ${interval.from.unit === "hours" ? "selected" : ""}>Horas</option>
              </select>
            </div>
            <div class="interval-field interval-boundary">
              <label for="interval-to-${index}">Hasta</label>
              <input id="interval-to-${index}" type="number" min="0.01" step="any" value="${interval.to.value}" data-interval-to required>
              <select data-interval-to-unit aria-label="Unidad del final del intervalo ${index + 1}">
                <option value="minutes" ${interval.to.unit === "minutes" ? "selected" : ""}>Minutos</option>
                <option value="hours" ${interval.to.unit === "hours" ? "selected" : ""}>Horas</option>
              </select>
            </div>
            <div class="interval-field">
              <label for="interval-amount-${index}">Monto (Bs)</label>
              <input id="interval-amount-${index}" type="number" min="0" step="0.01" value="${interval.amount}" data-interval-amount required>
            </div>
            <button class="btn btn-quiet" type="button" data-remove-interval="${index}" aria-label="Quitar intervalo ${index + 1}" ${draftIntervals.length === 1 ? "disabled" : ""}>Quitar</button>
          </div>
        `).join("");
      $("#openIntervalLabel").textContent = "Se cobra el monto fijo del rango en que cae la estadía. El monto del último rango se mantiene para tiempos mayores.";
    }

    intervalList.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("[data-remove-interval]")
        : null;
      if (!button || draftIntervals.length <= 1) return;
      readDraftIntervals();
      draftIntervals.splice(Number(button.dataset.removeInterval), 1);
      syncIntervalStarts();
      renderIntervals();
    });

    intervalList.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches("[data-interval-to]")) return;
      readDraftIntervals();
      syncIntervalStarts();
      intervalList.querySelectorAll(".interval-row").forEach((row, index) => {
        if (index === 0) return;
        row.querySelector("[data-interval-from]").value = draftIntervals[index].from.value;
        row.querySelector("[data-interval-from-unit]").value = draftIntervals[index].from.unit;
      });
    });

    intervalList.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLSelectElement)
        || !event.target.matches("[data-interval-from-unit], [data-interval-to-unit]")) return;
      const row = event.target.closest(".interval-row");
      const index = [...intervalList.querySelectorAll(".interval-row")].indexOf(row);
      const boundary = event.target.matches("[data-interval-from-unit]") ? "from" : "to";
      const previousBoundary = draftIntervals[index][boundary];
      const unit = event.target.value;
      row.querySelector(`[data-interval-${boundary}]`).value =
        convertBoundaryValue(previousBoundary.value, previousBoundary.unit, unit);
      readDraftIntervals();
      syncIntervalStarts();
      renderIntervals();
    });

    $("#addInterval")?.addEventListener("click", () => {
      readDraftIntervals();
      syncIntervalStarts();
      if (draftIntervals.some((interval) => {
        const fromMinutes = interval.from.value * (interval.from.unit === "hours" ? 60 : 1);
        const toMinutes = interval.to.value * (interval.to.unit === "hours" ? 60 : 1);
        return !Number.isFinite(toMinutes) || toMinutes <= fromMinutes
          || !Number.isFinite(interval.amount) || interval.amount < 0;
      })) {
        window.ParkFlow.showToast("Completa cada límite y monto; «Hasta» debe ser mayor que «De».");
        return;
      }
      const lastEnd = draftIntervals[draftIntervals.length - 1].to;
      const lastEndMinutes = lastEnd.value * (lastEnd.unit === "hours" ? 60 : 1);
      draftIntervals.push({
        from: { ...lastEnd },
        to: { value: lastEndMinutes + 30, unit: "minutes" },
        amount: 2.5,
      });
      renderIntervals();
    });

    renderIntervals();
  }

  const invoiceDialog = $("#invoiceDialog");
  $("#cancelInvoice")?.addEventListener("click", requestInvoiceCancellation);
  invoiceDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestInvoiceCancellation();
  });
  $("#keepInvoice")?.addEventListener("click", () => $("#cancelInvoiceDialog")?.close());
  $("#confirmInvoiceCancellation")?.addEventListener("click", () => {
    $("#cancelInvoiceDialog")?.close();
    invoiceDialog?.close();
    pendingInvoice = null;
  });
  $("#confirmInvoicePayment")?.addEventListener("click", () => {
    if (!pendingInvoice) return;
    const email = $("#invoiceCustomerEmail");
    if (email.value && !email.checkValidity()) {
      email.reportValidity();
      return;
    }
    const paid = window.ParkFlow.confirmPayment(
      pendingInvoice.vehicleId,
      pendingInvoice.total,
      {
        nit: $("#invoiceCustomerNit").value,
        name: $("#invoiceCustomerName").value,
        email: email.value,
      },
    );
    if (paid) {
      invoiceDialog?.close();
      pendingInvoice = null;
      return;
    }
    const refreshedInvoice = window.ParkFlow.createInvoice(pendingInvoice.vehicleId);
    if (refreshedInvoice) updateInvoice(refreshedInvoice);
  });

  $("#clearHistory")?.addEventListener("click", () => {
    const dialog = $("#confirmDialog");

    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
      return;
    }

    if (window.confirm("¿Restablecer los datos?")) {
      window.ParkFlow.resetDemo();
    }
  });

  $("#confirmReset")?.addEventListener("click", (event) => {
    event.preventDefault();
    window.ParkFlow.resetDemo();
    $("#confirmDialog")?.close();
  });

  const layoutSizeForm = $("#layoutSizeForm");
  if (layoutSizeForm) {
    let draftFloors = window.ParkFlow.getState().layout.floors.map((floor) => ({
      ...floor,
      cells: floor.cells.slice(),
    }));
    let activeFloorIndex = 0;
    let selectedTileType = "parking";

    const tileTypes = [
      ["parking", "Espacio", "P"],
      ["aisle", "Pasillo", "↕"],
      ["entrance", "Entrada", "⇧"],
      ["ramp", "Rampa", "↗"],
      ["circularRamp", "Rampa circular", "↻"],
      ["empty", "Vacío", "·"],
    ];

    function renderLayoutEditor() {
      const floorTabs = $("#layoutFloorTabs");
      const editorGrid = $("#layoutEditorGrid");
      const currentFloor = draftFloors[activeFloorIndex];
      if (!floorTabs || !editorGrid || !currentFloor) return;

      floorTabs.innerHTML = draftFloors.map((floor, index) => `
        <button class="floor-tab ${index === activeFloorIndex ? "active" : ""}" type="button"
          data-floor-index="${index}" aria-pressed="${index === activeFloorIndex}">
          ${floor.label}
        </button>
      `).join("");
      $("#layoutFloorCount").textContent = `${draftFloors.length} piso${draftFloors.length === 1 ? "" : "s"}`;

      const labels = Object.fromEntries(tileTypes.map(([type, label]) => [type, label]));
      editorGrid.style.setProperty("--columns", currentFloor.columns);
      editorGrid.innerHTML = currentFloor.cells.map((type, index) => {
        const row = Math.floor(index / currentFloor.columns) + 1;
        const column = (index % currentFloor.columns) + 1;
        const icon = tileTypes.find(([tileType]) => tileType === type)?.[2] || "·";
        const label = labels[type] || "Vacío";
        return `
          <button type="button" class="layout-tile cell-${type}" data-cell-index="${index}"
            aria-label="Fila ${row}, columna ${column}: ${label}" title="Fila ${row}, columna ${column}">
            <strong aria-hidden="true">${icon}</strong><span>${label}</span>
          </button>
        `;
      }).join("");

      document.querySelectorAll("[data-layout-type]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.layoutType === selectedTileType));
      });

      const state = window.ParkFlow.getState();
      const isLocked = state.vehicles.length > 0;
      $("#saveLayout")?.toggleAttribute("disabled", isLocked);
      $("#layoutLockMessage").hidden = !isLocked;
    }

    function buildFloorList(basements, aboveGround, rows, columns) {
      const definitions = [];
      for (let level = basements; level > 0; level -= 1) {
        definitions.push({ id: `S${level}`, label: `Subsuelo ${level}` });
      }
      definitions.push({ id: "PB", label: "Planta baja" });
      for (let level = 1; level < aboveGround; level += 1) {
        definitions.push({ id: `P${level}`, label: `Piso ${level}` });
      }

      return definitions.map((definition) => {
        const previous = draftFloors.find((floor) => floor.id === definition.id);
        const cells = Array.from({ length: rows * columns }, (_, index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;
          if (!previous || row >= previous.rows || column >= previous.columns) return "empty";
          return previous.cells[row * previous.columns + column] || "empty";
        });
        return { ...definition, rows, columns, cells };
      });
    }

    layoutSizeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!layoutSizeForm.reportValidity()) return;

      const basements = Number($("#basementCount").value);
      const aboveGround = Number($("#aboveGroundCount").value);
      const rows = Number($("#layoutRows").value);
      const columns = Number($("#layoutColumns").value);

      draftFloors = buildFloorList(basements, aboveGround, rows, columns);
      activeFloorIndex = Math.min(activeFloorIndex, draftFloors.length - 1);
      renderLayoutEditor();
      window.ParkFlow.showToast("Estructura actualizada. Selecciona un elemento y dibújalo en cada piso.");
    });

    $("#layoutTools")?.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("[data-layout-type]")
        : null;
      if (!button) return;
      selectedTileType = button.dataset.layoutType;
      renderLayoutEditor();
    });

    $("#layoutFloorTabs")?.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("[data-floor-index]")
        : null;
      if (!button) return;
      activeFloorIndex = Number(button.dataset.floorIndex);
      renderLayoutEditor();
    });

    $("#layoutEditorGrid")?.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("[data-cell-index]")
        : null;
      if (!button || !draftFloors[activeFloorIndex]) return;
      draftFloors[activeFloorIndex].cells[Number(button.dataset.cellIndex)] = selectedTileType;
      renderLayoutEditor();
    });

    $("#saveLayout")?.addEventListener("click", () => {
      if (window.ParkFlow.saveLayout({ floors: draftFloors })) {
        draftFloors = window.ParkFlow.getState().layout.floors.map((floor) => ({
          ...floor,
          cells: floor.cells.slice(),
        }));
        renderLayoutEditor();
      }
    });

    const currentLayout = window.ParkFlow.getState().layout;
    const basementCount = currentLayout.floors.filter((floor) => floor.id.startsWith("S")).length;
    const aboveGroundCount = currentLayout.floors.filter((floor) => floor.id === "PB" || floor.id.startsWith("P")).length;
    $("#basementCount").value = basementCount;
    $("#aboveGroundCount").value = aboveGroundCount;
    $("#layoutRows").value = currentLayout.floors[0].rows;
    $("#layoutColumns").value = currentLayout.floors[0].columns;
    renderLayoutEditor();
  }

  window.ParkFlow.render();
  window.setInterval(window.ParkFlow.render, 1000);
})();
