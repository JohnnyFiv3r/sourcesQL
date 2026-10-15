import { brandIcon } from "./branding.js";

type TokenView = {
  readToken(): string;
  clearToken(): void;
  setBusy(busy: boolean): void;
  showError(message: string): void;
  connected(): void;
};

export function tokenSubmitter(
  view: TokenView,
  connect: (token: string) => Promise<void>,
): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) return;
    const token = view.readToken().trim();
    view.clearToken();
    view.showError("");
    if (!token) {
      view.showError("Enter your server access token.");
      return;
    }
    busy = true;
    view.setBusy(true);
    try {
      await connect(token);
      view.connected();
    } catch {
      // Transport errors may contain headers or response bodies. Never display them.
      view.showError(
        "Unable to connect. Check your access token and connection, then try again.",
      );
    } finally {
      busy = false;
      view.setBusy(false);
    }
  };
}

export function mountHostAuth(
  container: HTMLElement,
  connect: (token: string) => Promise<void>,
): void {
  container.style.cssText =
    "display:flex;flex:1;min-height:0;align-items:center;justify-content:center;padding:24px;overflow:auto";
  const form = document.createElement("form");
  form.noValidate = true;
  form.method = "post";
  form.autocomplete = "off";
  form.style.cssText = "width:100%;max-width:380px";
  const logo = document.createElement("img");
  logo.src = brandIcon;
  logo.alt = "sourcesQL";
  logo.width = logo.height = 56;
  logo.style.cssText = "display:block;border-radius:12px;margin-bottom:20px";
  const title = document.createElement("h1");
  title.textContent = "Connect to sourcesQL";
  title.style.cssText = "font-size:24px;font-weight:550;margin:0 0 12px";
  const help = document.createElement("p");
  help.id = "host-auth-help";
  help.textContent = "Your server access token stays only in this page.";
  help.style.cssText =
    "font-size:14px;line-height:1.5;margin:0 0 24px;color:#626b7a";
  const label = document.createElement("label");
  label.htmlFor = "host-access-token";
  label.textContent = "Server access token";
  label.style.cssText = "display:block;font-size:14px;margin-bottom:8px";
  const input = document.createElement("input");
  input.id = label.htmlFor;
  input.type = "password";
  input.required = true;
  input.maxLength = 4096;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  // No name: even an unexpected native form submission cannot serialize the token.
  input.setAttribute("aria-describedby", "host-auth-help host-auth-error");
  input.style.cssText =
    "width:100%;min-height:44px;padding:10px 12px;font:inherit;border:1px solid #bfc6d2;border-radius:6px";
  const error = document.createElement("p");
  error.id = "host-auth-error";
  error.setAttribute("role", "alert");
  error.style.cssText =
    "font-size:14px;line-height:1.5;color:#943925;margin:12px 0";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Connect";
  button.style.cssText =
    "min-height:44px;padding:10px 18px;border:0;border-radius:6px;background:#17654b;color:white;font:inherit;cursor:pointer";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.style.cssText = "margin-left:12px;font-size:14px";
  form.append(logo, title, help, label, input, error, button, status);
  container.replaceChildren(form);
  const submit = tokenSubmitter(
    {
      readToken: () => input.value,
      clearToken: () => {
        input.value = "";
      },
      setBusy: (busy) => {
        input.disabled = button.disabled = busy;
        form.setAttribute("aria-busy", String(busy));
        status.textContent = busy ? "Connecting…" : "";
        if (!busy && container.isConnected) input.focus();
      },
      showError: (message) => {
        error.textContent = message;
        if (message) input.focus();
      },
      connected: () => container.remove(),
    },
    connect,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.focus();
}
