import {
  checkDevice,
  DeviceStore,
  sshCommand,
  validateDevice,
  type Device,
} from "./devices.ts";
import type { Runner } from "./process.ts";
import type { UI } from "./wizard.ts";
export type DeviceMenuContext = { ui: UI; store: DeviceStore; runner: Runner };
function explain({ ui, store }: DeviceMenuContext): void {
  ui.log(
    store.memory
      ? "设备档案仅在本次内存使用，不持久化；退出后清空。"
      : `设备连接档案：${store.path}；跨项目复用，仅保存 IP/DNS、用户名和端口，文件权限 600。`,
  );
  ui.log(
    "连接使用本机 SSH agent、默认密钥或 ~/.ssh/config。不会保存密码、私钥或驻留 SSH 会话；每次操作重新建立安全连接。",
  );
}
function preview(ui: UI, device: Device): void {
  ui.log(
    `设备：${device.label} (${device.id})\n主机：${device.host}\n用户名：${device.user}\n端口：${device.port}`,
  );
}
async function edit(
  context: DeviceMenuContext,
  current?: Device,
): Promise<void> {
  const { ui, store } = context;
  const id =
    current?.id ?? (await ui.input("设备标识（字母、数字、横杠或下划线）"));
  if (!current && store.read(id)) {
    ui.log("设备标识已存在，请选择该设备修改。");
    return;
  }
  const label = await ui.input("设备名称", { value: current?.label });
  const host = await ui.input(
    "设备 IP 或 DNS / SSH 配置别名（不含用户名或协议）",
    { value: current?.host },
  );
  const user = await ui.input("SSH 用户名", { value: current?.user });
  const portText = await ui.input("SSH 端口", {
    value: String(current?.port ?? 22),
  });
  if (!/^\d{1,5}$/.test(portText)) throw new Error("SSH 端口不合法。");
  const device = validateDevice({
    id,
    label,
    host,
    user,
    port: Number(portText),
  });
  preview(ui, device);
  if (
    await ui.confirm(
      store.memory
        ? "确认本次使用此设备档案（不持久化）？"
        : "确认保存此设备连接档案？",
    )
  ) {
    await store.save(device);
    ui.log(store.memory ? "设备档案已放入本次内存。" : "设备档案已保存。");
  }
}
async function details(context: DeviceMenuContext, id: string): Promise<void> {
  const { ui, store, runner } = context;
  while (true) {
    const device = store.read(id);
    if (!device) return;
    preview(ui, device);
    const action = await ui.select("设备连接与管理", [
      { name: "只读 SSH 连通性检查", value: "check" },
      { name: "显示本机 SSH 连接命令", value: "command" },
      { name: "修改连接档案", value: "edit" },
      { name: "删除连接档案", value: "delete" },
      { name: "返回设备列表", value: "back" },
    ]);
    if (action === "back") return;
    try {
      if (action === "edit") await edit(context, device);
      if (
        action === "delete" &&
        (await ui.confirm(
          `确认删除设备档案 ${device.label}？不会修改远端设备。`,
        ))
      ) {
        await store.remove(id);
        return;
      }
      if (action === "command") {
        ui.log(sshCommand(device));
        ui.log(
          "在本机终端执行；首次连接需自行核对可信的主机指纹。工具命令使用严格指纹校验，不会自动接受未知主机。",
        );
      }
      if (action === "check") {
        try {
          await checkDevice(device, runner);
          ui.log(
            "SSH 连通性通过，仅执行 true；尚未验证 Docker、资源容量或应用部署。",
          );
        } catch {
          ui.log(
            "SSH 检查失败。请先在本机正常运行 ssh，核对可信的主机指纹，并检查 SSH agent、默认密钥和 ~/.ssh/config；不会自动接受未知指纹或保存密码。",
          );
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        ["ExitPromptError", "AbortPromptError"].includes(error.name)
      )
        throw error;
      ui.log(
        "设备操作未完成；请检查输入、私有文件权限和是否有其他进程修改档案。未确认的更改不会保存。",
      );
    }
  }
}
export async function deviceMenu(context: DeviceMenuContext): Promise<void> {
  explain(context);
  while (true) {
    const action = await context.ui.select("部署设备档案", [
      ...context.store.list().map((device) => ({
        name: `${device.label} (${device.user}@${device.host}:${device.port})`,
        value: `device:${device.id}`,
      })),
      { name: "新增设备（IP / 用户名 / 端口）", value: "add" },
      { name: "返回", value: "back" },
    ]);
    if (action === "back") return;
    try {
      if (action === "add") await edit(context);
      else if (action.startsWith("device:"))
        await details(context, action.slice(7));
    } catch (error) {
      if (
        error instanceof Error &&
        ["ExitPromptError", "AbortPromptError"].includes(error.name)
      )
        throw error;
      context.ui.log(
        "设备操作未完成；请检查输入、私有文件权限和是否有其他进程修改档案。未确认的更改不会保存。",
      );
    }
  }
}
export async function selectDevice(
  context: DeviceMenuContext,
): Promise<Device | undefined> {
  explain(context);
  while (true) {
    const action = await context.ui.select("选择部署设备", [
      ...context.store.list().map((device) => ({
        name: `${device.label} (${device.user}@${device.host}:${device.port})`,
        value: `device:${device.id}`,
      })),
      { name: "新增或管理设备", value: "manage" },
      { name: "返回", value: "back" },
    ]);
    if (action === "back") return;
    if (action === "manage") await deviceMenu(context);
    else if (action.startsWith("device:"))
      return context.store.read(action.slice(7));
  }
}
