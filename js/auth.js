"use strict";

(() => {
  const ACCOUNT_KEY = "parkflow-accounts-v1";
  const SESSION_KEY = "parkflow-session-v1";
  const ADMIN_EMAIL = "imanaadiel4@gmail.com";
  const ADMIN_SALT = "parkflow-admin-v1";
  const ADMIN_PASSWORD_HASH = "93c687ba4c03bb5114e602c87545ad62f1de9584e0ad94182b7d49c0ae906eb5";
  const ROLE_LABELS = { admin: "Administrador", supervisor: "Supervisor", employee: "Empleado" };
  const currentPage = location.pathname.split("/").pop() || "index.html";
  const isLoginPage = currentPage === "login.html";
  let currentUser = null;

  function readAccounts() {
    try {
      const accounts = JSON.parse(localStorage.getItem(ACCOUNT_KEY));
      return Array.isArray(accounts) ? accounts : [];
    } catch (error) {
      return [];
    }
  }

  function saveAccounts(accounts) {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(accounts));
  }

  function getAccount(email) {
    return readAccounts().find((account) => account.email === email) || null;
  }

  function ensureAdminAccount() {
    const accounts = readAccounts();
    if (accounts.some((account) => account.email === ADMIN_EMAIL)) return;
    accounts.push({
      email: ADMIN_EMAIL,
      role: "admin",
      salt: ADMIN_SALT,
      passwordHash: ADMIN_PASSWORD_HASH,
    });
    saveAccounts(accounts);
  }

  function hashPassword(password, salt) {
    const bytes = new TextEncoder().encode(`${salt}${password}`);
    return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
  }

  function canManageTariff() {
    return Boolean(currentUser && currentUser.role !== "employee");
  }

  function canManageLayout() {
    return Boolean(currentUser && currentUser.role === "admin");
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

  function renderAccounts() {
    const accountList = document.querySelector("#accountList");
    if (!accountList) return;
    const accounts = readAccounts().filter((account) => account.role !== "admin");
    accountList.innerHTML = accounts.length
      ? accounts.map((account) => `
        <tr>
          <td>${escapeHtml(account.email)}</td>
          <td>
            <label class="visually-hidden" for="role-${escapeHtml(account.email)}">Cargo de ${escapeHtml(account.email)}</label>
            <select id="role-${escapeHtml(account.email)}" data-account-role="${escapeHtml(account.email)}">
              <option value="supervisor" ${account.role === "supervisor" ? "selected" : ""}>Supervisor</option>
              <option value="employee" ${account.role === "employee" ? "selected" : ""}>Empleado</option>
            </select>
          </td>
          <td><button class="btn btn-quiet" type="button" data-remove-account="${escapeHtml(account.email)}">Retirar cargo</button></td>
        </tr>
      `).join("")
      : '<tr><td colspan="3" class="table-empty">Todavía no hay cuentas de supervisores o empleados.</td></tr>';
  }

  function applyPermissions() {
    const roleLabel = ROLE_LABELS[currentUser.role] || "Usuario";
    document.querySelectorAll("[data-auth-user]").forEach((element) => {
      element.textContent = `${currentUser.email} · ${roleLabel}`;
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
      identity.textContent = `${currentUser.email} · ${roleLabel}`;
      const logout = document.createElement("button");
      logout.className = "btn btn-quiet auth-logout";
      logout.type = "button";
      logout.dataset.authLogout = "";
      logout.textContent = "Cerrar sesión";
      topbar.append(identity, logout);
    }

    renderAccounts();
    document.documentElement.dataset.authPending = "false";
  }

  function renderLoginError(message) {
    showMessage(document.querySelector("#loginMessage"), message);
  }

  function initializeLogin() {
    const form = document.querySelector("#loginForm");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button[type='submit']");
      submit.disabled = true;
      const email = String(new FormData(form).get("email")).trim().toLowerCase();
      const password = String(new FormData(form).get("password"));
      const account = getAccount(email);

      try {
        if (!account || await hashPassword(password, account.salt) !== account.passwordHash) {
          renderLoginError("Correo o contraseña incorrectos.");
          return;
        }
        sessionStorage.setItem(SESSION_KEY, account.email);
        const requestedPage = new URLSearchParams(location.search).get("next");
        const validPages = ["index.html", "vehicles.html", "spaces.html", "tariff.html", "layout.html", "accounts.html"];
        location.replace(validPages.includes(requestedPage) ? requestedPage : "index.html");
      } catch (error) {
        renderLoginError("No se pudo verificar el acceso. Abre ParkFlow desde un servidor local seguro.");
      } finally {
        submit.disabled = false;
      }
    });
  }

  function initializeAccountManagement() {
    const form = document.querySelector("#accountForm");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const email = String(data.get("email")).trim().toLowerCase();
      const password = String(data.get("password"));
      const role = String(data.get("role"));
      const message = document.querySelector("#accountMessage");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMessage(message, "Escribe un correo válido.");
        return;
      }
      if (password.length < 8) {
        showMessage(message, "La contraseña debe tener al menos 8 caracteres.");
        return;
      }
      if (!["supervisor", "employee"].includes(role)) {
        showMessage(message, "Selecciona un cargo válido.");
        return;
      }
      if (getAccount(email)) {
        showMessage(message, "Ya existe una cuenta con ese correo.");
        return;
      }
      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(password, salt);
      const accounts = readAccounts();
      accounts.push({ email, role, salt, passwordHash });
      saveAccounts(accounts);
      form.reset();
      showMessage(message, "Cuenta creada correctamente.", false);
      renderAccounts();
    });

    document.querySelector("#accountList")?.addEventListener("change", (event) => {
      const select = event.target.closest("[data-account-role]");
      if (!select) return;
      const accounts = readAccounts();
      const account = accounts.find((item) => item.email === select.dataset.accountRole);
      if (!account || !["supervisor", "employee"].includes(select.value)) return;
      account.role = select.value;
      saveAccounts(accounts);
      if (currentUser.email === account.email) currentUser = account;
      renderAccounts();
    });

    document.querySelector("#accountList")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-account]");
      if (!button) return;
      const email = button.dataset.removeAccount;
      if (!window.confirm(`¿Retirar el cargo de ${email}? Ya no podrá iniciar sesión.`)) return;
      saveAccounts(readAccounts().filter((account) => account.email !== email));
      renderAccounts();
    });
  }

  ensureAdminAccount();
  if (isLoginPage) {
    initializeLogin();
    if (sessionStorage.getItem(SESSION_KEY) && getAccount(sessionStorage.getItem(SESSION_KEY))) {
      location.replace("index.html");
    } else {
      document.documentElement.dataset.authPending = "false";
    }
  } else {
    const sessionEmail = sessionStorage.getItem(SESSION_KEY);
    currentUser = sessionEmail ? getAccount(sessionEmail) : null;
    if (!currentUser) {
      const next = encodeURIComponent(currentPage);
      location.replace(`login.html?next=${next}`);
    } else if (currentPage === "accounts.html" && currentUser.role !== "admin") {
      location.replace("index.html");
    } else {
      applyPermissions();
      initializeAccountManagement();
    }
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-auth-logout]")) {
      sessionStorage.removeItem(SESSION_KEY);
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

  window.ParkFlowAuth = {
    canManageTariff,
    canManageLayout,
    getCurrentUser: () => currentUser,
  };
})();