"use strict";

(() => {
  const ROLE_LABELS = { admin: "Administrador", supervisor: "Supervisor", employee: "Empleado" };
  const currentPage = location.pathname.split("/").pop() || "index.html";
  const isLoginPage = currentPage === "login.html";
  let currentUser = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "No se pudo completar la solicitud.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function request(method, body) {
    return { method, body: JSON.stringify(body) };
  }

  function canManageTariff() {
    return !currentUser || currentUser.role !== "employee";
  }

  function canManageLayout() {
    return !currentUser || currentUser.role === "admin";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[character]));
  }

  function showMessage(element, message, isError = true) {
    if (!element) return;
    element.textContent = message;
    element.dataset.error = String(isError);
  }

  async function renderAccounts() {
    const accountList = document.querySelector("#accountList");
    if (!accountList) return;
    try {
      const { accounts } = await api("/api/accounts");
      accountList.innerHTML = accounts.length
        ? accounts.map((account) => `
          <tr>
            <td>${escapeHtml(account.first_name)} ${escapeHtml(account.last_name)}</td>
            <td>${escapeHtml(account.identity_document || "-")}</td>
            <td>${escapeHtml(account.phone)}</td>
            <td>${escapeHtml(account.email)}</td>
            <td>
              <label class="visually-hidden" for="role-${escapeHtml(account.id)}">Cargo de ${escapeHtml(account.email)}</label>
              <select id="role-${escapeHtml(account.id)}" data-account-role="${escapeHtml(account.id)}">
                <option value="supervisor" ${account.role === "supervisor" ? "selected" : ""}>Supervisor</option>
                <option value="employee" ${account.role === "employee" ? "selected" : ""}>Empleado</option>
              </select>
            </td>
            <td><button class="btn btn-quiet" type="button" data-remove-account="${escapeHtml(account.id)}">Retirar cargo</button></td>
          </tr>
        `).join("")
        : '<tr><td colspan="6" class="table-empty">Todavía no hay cuentas de supervisores o empleados.</td></tr>';
    } catch (error) {
      showMessage(document.querySelector("#accountMessage"), error.message);
    }
  }

  function applyPermissions() {
    const roleLabel = ROLE_LABELS[currentUser.role] || "Usuario";
    document.querySelectorAll("[data-auth-user]").forEach((element) => {
      element.textContent = `${currentUser.firstName} ${currentUser.lastName} · ${currentUser.parkingLotName} · ${roleLabel}`;
    });
    document.querySelectorAll("[data-admin-only]").forEach((element) => {
      element.hidden = currentUser.role !== "admin";
    });
    document.querySelectorAll('a[href="layout.html"]').forEach((link) => {
      link.hidden = !canManageLayout();
    });
    document.querySelectorAll('a[href="tariff.html"]').forEach((link) => {
      link.hidden = !canManageTariff();
    });

    const restrictions = [];
    if (!canManageLayout()) restrictions.push([".layout-setup-panel, .layout-editor-panel, .layout-save-row", "Solo el administrador puede modificar el parqueo."]);
    if (!canManageTariff()) restrictions.push([".tariff-editor-panel", "Tu cargo permite consultar el tarifario, pero no modificarlo."]);
    restrictions.forEach(([selector, message]) => {
      const panels = [...document.querySelectorAll(selector)];
      if (!panels.length) return;
      const notice = document.createElement("p");
      notice.className = "permission-notice";
      notice.textContent = message;
      panels[0].before(notice);
      panels.forEach((panel) => {
        const disableControls = (container) => {
          if (container.matches?.("input, select, textarea, button")) container.disabled = true;
          container.querySelectorAll?.("input, select, textarea, button").forEach((control) => {
            control.disabled = true;
          });
        };
        disableControls(panel);
        new MutationObserver((records) => {
          records.forEach((record) => record.addedNodes.forEach((node) => {
              if (node instanceof HTMLElement) disableControls(node);
          }));
        }).observe(panel, { childList: true, subtree: true });
      });
    });

    const topbar = document.querySelector(".topbar-right");
    if (topbar && !topbar.querySelector("[data-auth-logout]")) {
      const identity = document.createElement("span");
      identity.className = "auth-identity";
      identity.dataset.authUser = "";
      identity.textContent = `${currentUser.firstName} ${currentUser.lastName} · ${currentUser.parkingLotName} · ${roleLabel}`;
      const logout = document.createElement("button");
      logout.className = "btn btn-quiet auth-logout";
      logout.type = "button";
      logout.dataset.authLogout = "";
      logout.textContent = "Cerrar sesión";
      topbar.append(identity, logout);
    }

    if (document.querySelector("#accountList")) renderAccounts();
    document.documentElement.dataset.authPending = "false";
  }

  function renderLoginError(message) {
    showMessage(document.querySelector("#loginMessage"), message);
  }

  function initializeLogin() {
    const form = document.querySelector("#loginForm");
    const parkingSelect = document.querySelector("#loginParkingLot");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button[type='submit']");
      submit.disabled = true;
      const data = new FormData(form);
      try {
        const result = await api("/api/auth/login", request("POST", {
          email: data.get("email"),
          password: data.get("password"),
          parkingLotId: data.get("parkingLotId"),
        }));
        if (result.selectParkingLot) {
          parkingSelect.replaceChildren(...result.parkingLots.map((lot) => {
            const option = document.createElement("option");
            option.value = lot.id;
            option.textContent = lot.name;
            return option;
          }));
          parkingSelect.hidden = false;
          parkingSelect.required = true;
          renderLoginError("Selecciona el parqueo al que deseas ingresar.");
          return;
        }
        const requestedPage = new URLSearchParams(location.search).get("next");
        const validPages = ["index.html", "vehicles.html", "spaces.html", "tariff.html", "layout.html", "accounts.html"];
        location.replace(validPages.includes(requestedPage) ? requestedPage : "index.html");
      } catch (error) {
        renderLoginError(error.message);
      } finally {
        submit.disabled = false;
      }
    });
  }

  function initializeParkingRegistration() {
    const form = document.querySelector("#registerParkingForm");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button[type='submit']");
      const message = document.querySelector("#registrationMessage");
      submit.disabled = true;
      try {
        await api("/api/auth/register-parking", request("POST", Object.fromEntries(new FormData(form))));
        location.replace("index.html");
      } catch (error) {
        showMessage(message, error.message);
      } finally {
        submit.disabled = false;
      }
    });
  }

  function initializeAccountManagement() {
    const form = document.querySelector("#accountForm");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.querySelector("#accountMessage");
      const submit = form.querySelector("button[type='submit']");
      submit.disabled = true;
      try {
        await api("/api/accounts", request("POST", Object.fromEntries(new FormData(form))));
        form.reset();
        showMessage(message, "Cuenta creada correctamente.", false);
        await renderAccounts();
      } catch (error) {
        showMessage(message, error.message);
      } finally {
        submit.disabled = false;
      }
    });

    document.querySelector("#accountList")?.addEventListener("change", async (event) => {
      const select = event.target.closest("[data-account-role]");
      if (!select) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(select.dataset.accountRole)}/role`, request("PATCH", { role: select.value }));
      } catch (error) {
        showMessage(document.querySelector("#accountMessage"), error.message);
      }
    });

    document.querySelector("#accountList")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-remove-account]");
      if (!button) return;
      if (!window.confirm("¿Retirar el cargo? La cuenta perderá acceso a este parqueo.")) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(button.dataset.removeAccount)}`, { method: "DELETE" });
        await renderAccounts();
      } catch (error) {
        showMessage(document.querySelector("#accountMessage"), error.message);
      }
    });
  }

  async function initializeSession() {
    try {
      const result = await api("/api/auth/me");
      currentUser = result.user;
      const stateReady = await window.ParkFlow.ready;
      if (!stateReady) {
        document.body.innerHTML = '<main class="panel auth-error"><h1>No se pudo cargar el parqueo</h1><p>El servidor no pudo recuperar los datos de este parqueo.</p></main>';
        document.documentElement.dataset.authPending = "false";
        return;
      }
      if (currentPage === "accounts.html" && currentUser.role !== "admin") {
        location.replace("index.html");
        return;
      }
      applyPermissions();
      initializeAccountManagement();
    } catch (error) {
      if (error.status === 401) {
        location.replace(`login.html?next=${encodeURIComponent(currentPage)}`);
        return;
      }
      document.body.innerHTML = '<main class="panel auth-error"><h1>Servicio no disponible</h1><p>No se pudo verificar la sesión con el servidor. Comprueba que ParkFlow y PostgreSQL estén activos y vuelve a cargar.</p></main>';
      document.documentElement.dataset.authPending = "false";
    }
  }

  window.ParkFlowAuth = {
    canManageTariff,
    canManageLayout,
    getCurrentUser: () => currentUser,
    ready: Promise.resolve(false),
  };

  if (isLoginPage) {
    initializeLogin();
    initializeParkingRegistration();
    api("/api/auth/me").then(() => location.replace("index.html")).catch((error) => {
      if (error.status !== 401) renderLoginError("No se pudo conectar con el servidor de ParkFlow.");
      document.documentElement.dataset.authPending = "false";
    });
  } else {
    window.ParkFlowAuth.ready = initializeSession().then(() => Boolean(currentUser));
  }

  document.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-auth-logout]")) return;
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      location.replace("login.html");
    }
  });

  ["click", "input", "change", "submit"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
    if (!currentUser) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if ((!canManageLayout() && target.closest(".layout-setup-panel, .layout-editor-panel"))
      || (!canManageTariff() && target.closest(".tariff-editor-panel"))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    }, true);
  });

})();