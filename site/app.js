// The catalog website. Everything is built from index.json; nothing is sent anywhere.
const $ = (id) => document.getElementById(id);
const SERVER_KEY = "podkit-address";
const STATUS = { broken: "Broken", unmaintained: "Unmaintained" };
const THEME_KEY = "podkit-theme";
let templates = [];
let category = "";

const server = () => localStorage.getItem(SERVER_KEY) || "";
const el = (tag, props = {}, ...children) => {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
};
const link = (href, text) => el("a", { href, rel: "noopener", target: "_blank", textContent: text });
const logo = (t, size = "") => el("span", { className: `logo ${size}` }, el("img", { src: `templates/${t.id}/${t.logo}`, alt: "", loading: "lazy" }));
const svg = (tag, attrs = {}, ...children) => {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
	node.append(...children);
	return node;
};
const icon = (name) => svg("svg", { class: "icon", "aria-hidden": "true" }, svg("use", { href: `icons.svg#${name}` }));

// The tile of a part, as podkit draws it: the mark of what it runs, or two letters on a tint
// that the name alone decides, so a part keeps its color on every load.
const MARKS = ["docker", "huggingface", "mariadb", "mongodb", "mysql", "ollama", "postgresql", "redis"];
const MARK_NAMES = { postgres: "postgresql", pg: "postgresql", mongo: "mongodb" };
function tile(part) {
	if (part.kind === "volume") return el("span", { className: "logo glyph", ariaHidden: "true" }, icon("hard-drive"));
	if (part.logo) return el("span", { className: "logo", ariaHidden: "true" }, el("img", { src: part.logo, alt: "", loading: "lazy" }));
	const id = MARK_NAMES[part.mark] || part.mark;
	if (MARKS.includes(id)) return el("span", { className: "logo mark", ariaHidden: "true" }, svg("svg", {}, svg("use", { href: `marks.svg#${id}` })));
	const letters = [...part.name].filter((c) => /[\p{L}\p{N}]/u.test(c));
	const node = el("span", { className: "logo", ariaHidden: "true", textContent: letters.length ? letters[0].toUpperCase() + (letters[1] || "").toLowerCase() : "?" });
	node.dataset.h = 1 + ([...new TextEncoder().encode(part.name.trim())].reduce((a, b) => a + b, 0) % 6);
	return node;
}

// A preset is drawn in the look of podkit's project canvas, on its sizes (a tile is 208 by 92;
// crates/core/src/projects/graph/layout.rs there): a frame per environment, a dashed frame
// around the parts that share a network, a tile per part. The site lays it out itself from the
// outline in the index, so the build needs no podkit.
//
// A stack of several services is drawn open, which podkit's canvas does not do: a frame with a
// tile per service, an arrow from each service to the ones it uses (its database, its cache)
// and a dashed line to a volume it shares with others. A service that uses another is left of
// it, as a consumer is left of its provider on the canvas.
const NODE = { w: 208, h: 92 };
const FRAME = { pad: 16, head: 44, gap: 16, between: 28, net: 14, netHead: 30, band: 20, col: 72 };
const KIND = { application: "application", database: "database", stack: "stack", model: "model" };
const short = (image) => image.split("/").pop();

// One open stack, placed from its own corner: its tiles in columns, and its lines.
function opened(part) {
	const nodes = [
		...part.services.map((s) => ({ ...s, key: `s:${s.name}`, kind: "service", detail: short(s.image) })),
		...part.shared.map((v) => ({ name: v.name, key: `v:${v.name}`, kind: "volume", detail: "shared volume" })),
	];
	const links = [
		...part.services.flatMap((s) => s.uses.map((u) => ({ from: `s:${s.name}`, to: `s:${u}`, kind: "uses" }))),
		...part.shared.flatMap((v) => v.services.map((s) => ({ from: `s:${s}`, to: `v:${v.name}`, kind: "volume" }))),
	];
	// A column is the longest way to a tile from one nothing points at. Two services that use
	// each other would push each other right forever: the passes stop at the number of tiles.
	const column = new Map(nodes.map((n) => [n.key, 0]));
	for (let pass = 0; pass < nodes.length; pass++) for (const l of links) if (column.get(l.to) <= column.get(l.from) && column.get(l.from) < nodes.length - 1) column.set(l.to, column.get(l.from) + 1);
	const rows = new Map();
	for (const n of nodes) {
		const c = column.get(n.key);
		n.x = FRAME.net + c * (NODE.w + FRAME.col);
		n.y = FRAME.netHead + (rows.get(c) || 0) * (NODE.h + FRAME.gap);
		rows.set(c, (rows.get(c) || 0) + 1);
	}
	const columns = Math.max(...column.values()) + 1;
	const tallest = Math.max(...rows.values());
	return {
		name: part.name,
		nodes,
		links,
		w: 2 * FRAME.net + columns * NODE.w + (columns - 1) * FRAME.col,
		h: FRAME.netHead + tallest * NODE.h + (tallest - 1) * FRAME.gap + FRAME.net,
	};
}

function layout(outline) {
	const out = { node: NODE, environments: [], networks: [], stacks: [], nodes: [], links: [], width: 0, height: 0 };
	let x = 0;
	for (const env of outline.environments) {
		// A part is drawn in its first network; the parts on none come after the frames.
		const home = (p) => outline.networks.find((n) => n.members.some((m) => m.environment === env.slug && m.kind === KIND[p.kind] && m.name === p.name));
		const bands = [...outline.networks.map((n) => ({ net: n, parts: env.parts.filter((p) => home(p) === n) })), { net: null, parts: env.parts.filter((p) => !home(p)) }]
			.filter((b) => b.parts.length)
			.map((b) => ({ net: b.net, tiles: b.parts.filter((p) => !p.services), stacks: b.parts.filter((p) => p.services).map(opened) }));
		// More than three tiles in a band go in columns, so a big preset is not one tall strip.
		for (const b of bands) b.cols = Math.max(1, Math.ceil(b.tiles.length / 3));
		const inner = (b) => Math.max(b.cols * NODE.w + (b.cols - 1) * FRAME.gap, ...b.stacks.map((s) => s.w));
		const content = Math.max(NODE.w, ...bands.map(inner)) + 2 * FRAME.net;
		const left = x + FRAME.pad + FRAME.net;
		let y = FRAME.head;
		for (const band of bands) {
			const top = y + (band.net ? FRAME.netHead : 0);
			let cursor = top;
			band.tiles.forEach((p, i) => out.nodes.push({ ...p, x: left + (i % band.cols) * (NODE.w + FRAME.gap), y: top + Math.floor(i / band.cols) * (NODE.h + FRAME.gap) }));
			const rows = Math.ceil(band.tiles.length / band.cols);
			if (rows) cursor += rows * NODE.h + (rows - 1) * FRAME.gap + FRAME.gap;
			for (const stack of band.stacks) {
				out.stacks.push({ name: stack.name, rect: { x: left, y: cursor, w: stack.w, h: stack.h } });
				const placed = new Map(stack.nodes.map((n) => [n.key, { ...n, x: left + n.x, y: cursor + n.y }]));
				out.nodes.push(...placed.values());
				out.links.push(...stack.links.map((l) => ({ kind: l.kind, from: placed.get(l.from), to: placed.get(l.to) })));
				cursor += stack.h + FRAME.gap;
			}
			const bottom = cursor - FRAME.gap;
			if (band.net) out.networks.push({ name: band.net.name, rect: { x: x + FRAME.pad, y, w: content, h: bottom + FRAME.net - y } });
			y = bottom + (band.net ? FRAME.net : 0) + FRAME.band;
		}
		const width = content + 2 * FRAME.pad;
		const height = Math.max(y - FRAME.band, FRAME.head + NODE.h) + FRAME.pad;
		out.environments.push({ name: env.name, rect: { x, y: 0, w: width, h: height } });
		out.height = Math.max(out.height, height);
		x += width + FRAME.between;
	}
	out.width = Math.max(NODE.w, x - FRAME.between);
	// Environments side by side are one height, as on the canvas.
	for (const e of out.environments) e.rect.h = out.height;
	return out;
}
const at = (node, r) => {
	for (const [side, value] of [["left", r.x], ["top", r.y], ["width", r.w], ["height", r.h]]) if (value !== undefined) node.style[side] = `${value}px`;
	return node;
};
// A line leaves the right edge of the tile that uses and arrives at the left edge of what it uses.
const curve = (l) => {
	const [x1, y1, x2, y2] = [l.from.x + NODE.w, l.from.y + NODE.h / 2, l.to.x, l.to.y + NODE.h / 2];
	const bend = Math.max(28, (x2 - x1) / 2);
	return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 2} ${y2}`;
};
const canvas = (c) =>
	el("div", { className: "cv", tabIndex: 0, role: "group", ariaLabel: "What this preset makes" },
		at(
			el("div", { className: "cv-world" },
				...c.environments.map((e) => at(el("section", { className: "cv-env", ariaLabel: `${e.name} environment` }, el("h4", { textContent: e.name })), e.rect)),
				...c.networks.map((n) => at(el("div", { className: "cv-net" }, el("span", {}, icon("network"), n.name)), n.rect)),
				...c.stacks.map((s) => at(el("div", { className: "cv-stack" }, el("span", {}, icon("layers"), s.name)), s.rect)),
				svg("svg", { class: "cv-edges", width: c.width, height: c.height, "aria-hidden": "true" },
					svg("defs", {}, svg("marker", { id: "cv-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, svg("path", { d: "M1 1L9 5L1 9" }))),
					...c.links.map((l) => svg("path", { d: curve(l), class: l.kind, ...(l.kind === "uses" ? { "marker-end": "url(#cv-arrow)" } : {}) })),
				),
				...c.nodes.map((n) =>
					at(
						el("div", { className: "cv-node" },
							el("div", {}, tile(n), el("strong", { textContent: n.name })),
							el("small", {}, el("span", { className: "sr", textContent: `${n.kind}. ` }), n.detail),
						),
						{ x: n.x, y: n.y, w: c.node.w, h: c.node.h },
					),
				),
			),
			{ w: c.width, h: c.height },
		),
	);
// The same links in words, for whoever does not see the drawing.
const said = (part) => [
	...part.services.filter((s) => s.uses.length).map((s) => `${s.name} uses ${s.uses.join(" and ")}`),
	...part.shared.map((v) => `${v.services.join(", ")} share the volume ${v.name}`),
];

// "2 environments, 4 databases": what applying the preset makes, in words.
const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function makes(outline) {
	const kinds = new Map();
	for (const p of outline.environments.flatMap((e) => e.parts)) kinds.set(p.kind, (kinds.get(p.kind) || 0) + 1);
	return [count(outline.environments.length, "environment"), ...[...kinds].map(([kind, n]) => count(n, kind))].join(" · ");
}
// What applying it asks of the person, read from the file: a server wherever it says
// "${choose}", the secrets to type in, and the ones podkit makes up.
function asks(p) {
	const nets = p.outline.networks.length;
	const generated = [...new Set([...p.file.matchAll(/\$\{generate:([^}]+)\}/g)].map((m) => m[1]))];
	const row = (label, ...what) => el("li", {}, el("b", { textContent: label }), el("span", {}, ...what));
	return [
		row("Servers", `One for each of its ${count(parts(p).length, "part")}${nets ? ` and for its ${nets === 1 ? "network" : "networks"}` : ""}. They can all be the same server.`),
		...Object.entries(p.secrets || {}).map(([name, why]) => row("You type in", el("code", { textContent: name }), ` ${why}`)),
		...(generated.length ? [row("podkit makes up", ...generated.flatMap((name, i) => [...(i ? [" "] : []), el("code", { textContent: name })]))] : []),
	];
}
const parts = (p) => p.outline.environments.flatMap((e) => e.parts);
// The marks of what a preset holds, each once, for its card.
const marks = (p) => [...new Map(parts(p).map((part) => [part.logo || part.mark || part.name, tile(part)])).values()].slice(0, 6);
function openPreset(p) {
	$("p-name").textContent = p.name;
	$("p-meta").textContent = makes(p.outline);
	$("p-description").textContent = p.description;
	$("p-tags").replaceChildren(...p.tags.map((t) => el("li", { textContent: t })));
	// Under the canvas, in words: who shares a network, and what each stack runs.
	const notes = [
		...p.outline.networks.map((n) => el("li", {}, icon("network"), el("span", {}, el("code", { textContent: n.name }), ` is a network that ${n.members.map((m) => m.name).join(", ")} share: they reach each other on it by name.`))),
		...parts(p).filter((part) => part.services).map((part) => el("li", {}, icon("layers"), el("span", {}, el("code", { textContent: part.name }), ` is one stack: ${said(part).join("; ") || part.services.map((s) => s.name).join(", ")}.`))),
	];
	$("p-canvas").replaceChildren(canvas(layout(p.outline)), ...(notes.length ? [el("ul", { className: "cv-notes" }, ...notes)] : []));
	$("p-asks").replaceChildren(...asks(p));
	$("p-files").replaceChildren(el("a", { href: `presets/${p.id}/preset.toml`, download: `${p.id}.toml` }, icon("download"), "preset.toml"));
	location.hash = `preset:${p.id}`;
	$("preset").showModal();
}
const preset = (p) => {
	const card = el("button", { type: "button", className: "card" },
		el("span", { className: "card-logos" }, ...marks(p)),
		el("strong", { textContent: p.name }),
		el("span", { className: "card-text", textContent: p.description }),
		el("span", { className: "card-foot", textContent: makes(p.outline) }),
	);
	card.addEventListener("click", () => openPreset(p));
	return el("li", {}, card);
};

function matches(t, words, category, hideFlagged) {
	if (category && t.category !== category) return false;
	if (hideFlagged && t.status !== "ok") return false;
	const text = `${t.name} ${t.id} ${t.tags.join(" ")} ${t.description}`.toLowerCase();
	return words.every((w) => text.includes(w));
}

function render() {
	const words = $("q").value.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = templates.filter((t) => matches(t, words, category, $("hide-flagged").checked));
	$("empty").hidden = shown.length > 0;
	$("shown").textContent = shown.length === templates.length ? "" : `${shown.length} of ${templates.length} templates`;
	for (const chip of $("categories").children) chip.ariaPressed = String(chip.value === category);
	$("grid").replaceChildren(
		...shown.map((t) => {
			const card = el("button", { type: "button", className: "row" },
				logo(t),
				el("span", { className: "row-main" }, el("strong", { textContent: t.name }), el("span", { textContent: t.description })),
				el("span", { className: "row-meta" },
					el("code", { textContent: t.version }),
					t.status === "ok" ? el("span", { textContent: t.category }) : el("span", { className: `badge ${t.status}`, textContent: STATUS[t.status] }),
				),
			);
			card.addEventListener("click", () => open(t));
			return el("li", {}, card);
		}),
	);
}

function open(t) {
	$("d-logo").src = `templates/${t.id}/${t.logo}`;
	$("d-name").textContent = t.name;
	$("d-meta").replaceChildren(el("span", { textContent: `Version ${t.version}` }), el("span", { textContent: t.category }), el("code", { textContent: t.revision, title: "Revision: it changes when what gets deployed changes" }));
	$("d-description").textContent = t.description;
	$("d-status").hidden = t.status === "ok";
	$("d-status").textContent = `${STATUS[t.status] || ""}: ${t.status_note}`;
	$("d-status").className = `status ${t.status}`;
	$("d-links").replaceChildren(...[[t.website, "Website"], [t.docs, "Documentation"], [t.source, "Source"]].map(([href, text]) => {
		const a = link(href, text);
		a.append(icon("external-link"));
		return a;
	}));
	$("d-files").replaceChildren(
		...t.files.map((f) => el("a", { href: `templates/${t.id}/${f.name}`, download: f.name }, icon("download"), f.name)),
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
for (const id of ["detail", "preset"]) $(id).addEventListener("close", () => history.replaceState(null, "", location.pathname + location.search));
$("d-copy").addEventListener("click", async () => {
	await navigator.clipboard.writeText($("d-cli").textContent);
	$("d-copy").textContent = "Copied";
	setTimeout(() => ($("d-copy").textContent = "Copy"), 1500);
});
for (const id of ["q", "hide-flagged"]) $(id).addEventListener("input", render);
$("categories").addEventListener("click", (e) => {
	const chip = e.target.closest("button");
	if (!chip) return;
	category = chip.value;
	render();
});
// The theme is the system's until a person picks one; the pick stays in this browser.
$("theme-button").addEventListener("click", () => {
	const root = document.documentElement;
	const dark = root.className ? root.className === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
	root.className = dark ? "light" : "dark";
	try { localStorage.setItem(THEME_KEY, root.className); } catch {}
});
// Hovering the brand plays the peek once. The class stays until the animation ends, so it
// always runs to the end, also when the pointer has left.
$("brand").addEventListener("mouseenter", () => $("brand").classList.add("play"));
$("brand").addEventListener("animationend", () => $("brand").classList.remove("play"));

fetch("index.json")
	.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`index.json: HTTP ${r.status}`))))
	.then((index) => {
		templates = index.templates;
		const presets = index.presets || [];
		$("count").replaceChildren(
			`${templates.length} templates${presets.length ? ` and ${count(presets.length, "preset")}` : ""}, free to use. Catalog `,
			el("code", { textContent: index.commit.slice(0, 7) || "unbuilt" }),
			".",
		);
		const per = new Map();
		for (const t of templates) per.set(t.category, (per.get(t.category) || 0) + 1);
		const chip = (value, label, n) => el("button", { type: "button", className: "chip", value }, label, el("small", { textContent: n }));
		$("categories").replaceChildren(chip("", "All", templates.length), ...[...per].sort().map(([c, n]) => chip(c, c, n)));
		$("presets").hidden = presets.length === 0;
		// The scenarios first: the presets that make the most.
		const size = (p) => parts(p).reduce((n, part) => n + (part.services ? part.services.length : 1), 0);
		presets.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name));
		$("preset-list").replaceChildren(...presets.map(preset));
		render();
		// A link to one template is #<id>, to one preset #preset:<id>.
		const hash = decodeURIComponent(location.hash.slice(1));
		const wanted = templates.find((t) => t.id === hash);
		const wantedPreset = presets.find((p) => `preset:${p.id}` === hash);
		if (wanted) open(wanted);
		else if (wantedPreset) openPreset(wantedPreset);
	})
	.catch((e) => ($("count").textContent = `The catalog did not load (${e.message}). Reload to try again.`));
