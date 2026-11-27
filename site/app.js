// The catalog website. Everything is built from index.json; nothing is sent anywhere.
const $ = (id) => document.getElementById(id);
const SERVER_KEY = "podkit-address";
const STATUS = { broken: "Broken", unmaintained: "Unmaintained" };
let templates = [];

const server = () => localStorage.getItem(SERVER_KEY) || "";
const el = (tag, props = {}, ...children) => {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
};
const link = (href, text) => el("a", { href, rel: "noopener", target: "_blank", textContent: text });
// A preset drawn as what it makes: one box per environment, one row per part.
const outline = (o) =>
	el("ul", { className: "outline", ariaLabel: "What this preset makes" },
		...((o && o.environments) || []).map((e) =>
			el("li", {},
				el("h3", { textContent: e.name }),
				el("ul", {}, ...e.parts.map((p) => el("li", {}, el("span", { textContent: p.name }), el("small", { textContent: [p.kind, p.detail].filter(Boolean).join(" \u00b7 ") })))),
			),
		),
		...((o && o.networks) || []).map((n) =>
			el("li", { className: "networks" }, el("h3", { textContent: `Network ${n.name}` }), el("small", { textContent: `Joins ${n.members.join(", ")}` })),
		),
	);

function matches(t, words, category, hideFlagged) {
	if (category && t.category !== category) return false;
	if (hideFlagged && t.status !== "ok") return false;
	const text = `${t.name} ${t.id} ${t.tags.join(" ")} ${t.description}`.toLowerCase();
	return words.every((w) => text.includes(w));
}

function render() {
	const words = $("q").value.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = templates.filter((t) => matches(t, words, $("category").value, $("hide-flagged").checked));
	$("empty").hidden = shown.length > 0;
	$("grid").replaceChildren(
		...shown.map((t) => {
			const card = el("button", { type: "button", className: "card" },
				el("img", { src: `templates/${t.id}/${t.logo}`, alt: "", width: 40, height: 40, loading: "lazy" }),
				el("span", { className: "card-text" },
					el("strong", { textContent: t.name }),
					el("span", { className: "muted", textContent: t.description }),
				),
			);
			if (t.status !== "ok") card.append(el("span", { className: `badge ${t.status}`, textContent: STATUS[t.status] }));
			card.addEventListener("click", () => open(t));
			return el("li", {}, card);
		}),
	);
}

function open(t) {
	$("d-logo").src = `templates/${t.id}/${t.logo}`;
	$("d-name").textContent = t.name;
	$("d-meta").textContent = `Version ${t.version} · ${t.category} · revision ${t.revision}`;
	$("d-description").textContent = t.description;
	$("d-status").hidden = t.status === "ok";
	$("d-status").textContent = `${STATUS[t.status] || ""}: ${t.status_note}`;
	$("d-status").className = `status ${t.status}`;
	$("d-links").replaceChildren(link(t.website, "Website"), link(t.docs, "Documentation"), link(t.source, "Source"));
	$("d-files").replaceChildren(
		...t.files.map((f) => el("a", { href: `templates/${t.id}/${f.name}`, download: f.name, textContent: f.name })),
	);
	$("d-cli").textContent = `podkit templates deploy ${t.id}`;
	const who = t.maintainers.map((m) => link(`https://github.com/${m}`, `@${m}`));
	const origin = t.origin === "dokploy"
		? [document.createTextNode("Adapted from the "), link("https://github.com/Dokploy/templates", "Dokploy community templates"), document.createTextNode(" (MIT). ")]
		: [document.createTextNode("Written for podkit. ")];
	$("d-credits").replaceChildren(...origin, ...(who.length ? [document.createTextNode("Maintained by "), ...who.flatMap((w, i) => (i ? [", ", w] : [w]))] : []));
	const deploy = $("d-deploy");
	deploy.dataset.id = t.id;
	// The link carries only the id. podkit looks it up in its own copy of the catalog and
	// shows a confirmation page: nothing is deployed by opening a link.
	deploy.href = server() ? `${server()}/market/${encodeURIComponent(t.id)}` : "#";
	$("d-deploy-note").textContent = server()
		? `Opens ${server()}. You confirm the deploy there.`
		: "Set your podkit address first. It stays in this browser.";
	location.hash = t.id;
	$("detail").showModal();
}

function askServer() {
	$("server-input").value = server();
	$("server").showModal();
}

$("server").addEventListener("close", () => {
	if ($("server").returnValue !== "save") return;
	const url = new URL($("server-input").value);
	localStorage.setItem(SERVER_KEY, url.origin);
	const current = templates.find((t) => t.id === $("d-deploy").dataset.id);
	if (current && $("detail").open) open(current);
});
$("d-deploy").addEventListener("click", (e) => {
	if (server()) return;
	e.preventDefault();
	askServer();
});
$("server-button").addEventListener("click", askServer);
$("detail").addEventListener("close", () => history.replaceState(null, "", location.pathname + location.search));
$("d-copy").addEventListener("click", async () => {
	await navigator.clipboard.writeText($("d-cli").textContent);
	$("d-copy").textContent = "Copied";
	setTimeout(() => ($("d-copy").textContent = "Copy"), 1500);
});
for (const id of ["q", "category", "hide-flagged"]) $(id).addEventListener("input", render);

fetch("index.json")
	.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`index.json: HTTP ${r.status}`))))
	.then((index) => {
		templates = index.templates;
		$("count").textContent = `${templates.length} templates, free to use. Catalog ${index.commit.slice(0, 7)}.`;
		for (const c of [...new Set(templates.map((t) => t.category))].sort()) $("category").append(el("option", { value: c, textContent: c }));
		const presets = index.presets || [];
		$("presets").hidden = presets.length === 0;
		$("preset-list").replaceChildren(
			...presets.map((p) =>
				el("li", { className: "preset" },
					el("div", { className: "card preset" },
						el("span", { className: "card-text" },
							el("strong", { textContent: p.name }),
							el("span", { className: "muted", textContent: p.description }),
						),
						outline(p.outline),
						el("a", { href: `presets/${p.id}/preset.toml`, download: `${p.id}.toml`, textContent: "preset.toml" }),
					),
				),
			),
		);
		render();
		const wanted = templates.find((t) => t.id === location.hash.slice(1));
		if (wanted) open(wanted);
	})
	.catch((e) => ($("count").textContent = `The catalog did not load (${e.message}). Reload to try again.`));
