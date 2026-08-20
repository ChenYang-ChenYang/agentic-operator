import type { MockErpStore, Row } from "./store.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function table(rows: Row[], columns: string[], rowAttrs?: (row: Row) => string): string {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr${rowAttrs ? ` ${rowAttrs(row)}` : ""}>${columns
          .map((c) => `<td>${esc(row[c])}</td>`)
          .join("")}</tr>`,
    )
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Meta ERP</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; background: #f4f5f7; color: #1c2330; }
  header { background: #1c2330; color: #fff; padding: 12px 24px;
           display: flex; align-items: baseline; gap: 24px; }
  header .brand { font-weight: 700; font-size: 16px; }
  header nav a { color: #aeb8c9; text-decoration: none; margin-right: 16px; font-size: 14px; }
  header nav a:hover { color: #fff; }
  main { max-width: 1080px; margin: 24px auto; padding: 0 24px; }
  h2 { font-size: 17px; margin: 28px 0 12px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 13px;
          border: 1px solid #dde1e8; }
  th, td { border-bottom: 1px solid #e8ebf0; padding: 7px 10px; text-align: left; }
  th { background: #eef0f4; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  form.create { background: #fff; border: 1px solid #dde1e8; padding: 16px;
                display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  form.create label { display: flex; flex-direction: column; font-size: 12px; gap: 4px; color: #4a5568; }
  form.create input { padding: 6px 8px; border: 1px solid #c8ced9; border-radius: 3px;
                      font-size: 13px; min-width: 160px; }
  button { background: #2455d6; color: #fff; border: none; border-radius: 3px;
           padding: 8px 16px; font-size: 13px; cursor: pointer; }
  button:hover { background: #1d46b3; }
  button.small { padding: 4px 10px; font-size: 12px; }
  .msg { margin: 10px 0; font-size: 13px; min-height: 18px; }
  .msg.ok { color: #1a7f37; } .msg.err { color: #c0392b; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #dde1e8; padding: 16px 20px; min-width: 220px; }
  .card a { color: #2455d6; text-decoration: none; font-weight: 600; }
  .card p { font-size: 13px; color: #4a5568; margin: 8px 0 0; }
</style>
</head>
<body>
<header>
  <span class="brand">Meta ERP</span>
  <nav>
    <a href="/ui">首页</a>
    <a href="/ui/transfers">调拨单</a>
    <a href="/ui/requisitions">采购需求</a>
  </nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function renderHome(store: MockErpStore): string {
  const entityCount = store.tables.size;
  const rowCount = [...store.tables.values()].reduce((n, rows) => n + rows.length, 0);
  return page(
    "首页",
    `<h2>Meta ERP · 演示实例</h2>
<div class="cards">
  <div class="card"><a href="/ui/transfers">跨仓调拨单</a><p>调拨单列表与创建（createTransferOrder）</p></div>
  <div class="card"><a href="/ui/requisitions">采购需求</a><p>需求列表与暂停操作（suspendRequisition）</p></div>
  <div class="card"><a href="/__journal">写入日志</a><p>${entityCount} 个实体 · ${rowCount} 行在内存中</p></div>
</div>`,
  );
}

export function renderTransfers(store: MockErpStore): string {
  const rows = store.rows("wm_transfer_order_t");
  const columns = ["TRANSFER_ID", "MATERIAL_CODE", "FROM_WH", "TO_WH", "WO_ID", "QTY", "STATUS", "ETA_HOURS"];
  return page(
    "调拨单",
    `<h2>跨仓调拨单</h2>
${table(rows, columns, (row) => `data-transfer-id="${esc(row["TRANSFER_ID"])}"`)}
<h2>创建调拨单</h2>
<form class="create" id="create-transfer" data-testid="create-transfer-form">
  <label>物料编码 <input name="material_id" data-testid="transfer-material-id" required placeholder="MAT-ST-P12"></label>
  <label>调出仓库 <input name="from_warehouse" data-testid="transfer-from-warehouse" required placeholder="Warehouse-WZ-01"></label>
  <label>调入仓库 <input name="to_warehouse" data-testid="transfer-to-warehouse" required placeholder="Warehouse-ST-01"></label>
  <label>数量 <input name="qty" data-testid="transfer-qty" type="number" required min="1" placeholder="1200"></label>
  <button type="submit" data-testid="transfer-submit">创建调拨单</button>
</form>
<p class="msg" id="transfer-msg" data-testid="transfer-msg"></p>
<script>
document.getElementById("create-transfer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("transfer-msg");
  const data = Object.fromEntries(new FormData(e.target).entries());
  data.qty = Number(data.qty);
  try {
    const res = await fetch("/metaerp/openapi/v1/createTransferOrder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
    msg.className = "msg ok";
    msg.textContent = "已创建调拨单 " + body.id;
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = "创建失败：" + err.message;
  }
});
</script>`,
  );
}

export function renderRequisitions(store: MockErpStore): string {
  const rows = store.rows("po_requisition_t");
  const columns = ["REQ_ID", "MATERIAL_CODE", "REQ_ORG_ID", "REQ_QTY", "BUDGET_AMT", "NEED_BY_DATE", "STATUS", "REASON"];
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("") + "<th>操作</th>";
  const body = rows
    .map((row) => {
      const cells = columns.map((c) => `<td>${esc(row[c])}</td>`).join("");
      const suspended = row["STATUS"] === "suspended";
      const action = suspended
        ? "<td>已暂停</td>"
        : `<td><button class="small suspend" data-req-id="${esc(row["REQ_ID"])}">暂停</button></td>`;
      return `<tr data-req-id="${esc(row["REQ_ID"])}">${cells}${action}</tr>`;
    })
    .join("\n");
  return page(
    "采购需求",
    `<h2>采购需求</h2>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<p class="msg" id="req-msg"></p>
<script>
document.querySelectorAll("button.suspend").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const msg = document.getElementById("req-msg");
    try {
      const res = await fetch("/metaerp/openapi/v1/suspendRequisition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ REQ_ID: btn.dataset.reqId }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
      msg.className = "msg ok";
      msg.textContent = "已暂停 " + body.id;
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = "操作失败：" + err.message;
    }
  });
});
</script>`,
  );
}
