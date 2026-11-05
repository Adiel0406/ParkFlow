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
  if (vehicleTable) {
    vehicleTable.addEventListener("click", (event) => {
      const target = event.target;
      const exitButton = target instanceof Element ? target.closest("[data-exit]") : null;
      const paymentButton = target instanceof Element ? target.closest("[data-pay]") : null;

      if (paymentButton) {
        window.ParkFlow.registerPayment(paymentButton.dataset.pay);
      } else if (exitButton) {
        window.ParkFlow.releaseVehicle(exitButton.dataset.exit);
      }
    });
  }

  $("#searchInput")?.addEventListener("input", window.ParkFlow.render);
  $("#typeFilter")?.addEventListener("change", window.ParkFlow.render);
  $("#undoExit")?.addEventListener("click", window.ParkFlow.undoLastExit);

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
