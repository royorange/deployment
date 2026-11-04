/** Fixed controller executed by Python 3 on the SSH target; it never evaluates project shell strings. */
export const controller = String.raw`
import os, sys, stat, pathlib, hashlib, subprocess, fcntl, re, tempfile

BASE = pathlib.Path(request["remoteDirectory"])
PROJECT = request["project"] + "-" + request["environment"]
OWNER_UID = 0
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}
registry_user = os.environ.get("SUDO_USER", "root")
state = {"current": None, "previous": None, "pending": None, "status": "absent"}

def require(condition):
    if not condition:
        raise RuntimeError("unverified")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result

def validate_compose_source(source):
    require(isinstance(source, str) and len(source.encode("utf8")) <= 64000)
    document = json.loads(source, object_pairs_hook=unique_object)
    require(isinstance(document, dict) and isinstance(document.get("services"), dict))

    def check(value, depth=0):
        require(depth <= 30)
        if isinstance(value, dict):
            require(not set(value).intersection({"include", "extends", "label_file", "provider", "models", "__proto__", "constructor", "prototype"}))
            for nested in value.values():
                check(nested, depth + 1)
        elif isinstance(value, list):
            for nested in value:
                check(nested, depth + 1)

    check(document)

def command(args, timeout=60):
    result = subprocess.run(args, input=b"", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV, timeout=timeout, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 2000000)
    return result.stdout.decode("utf8").strip()

def docker(args, registry=False):
    prefix = ["docker"]
    if registry and registry_user != "root":
        prefix = ["sudo", "-n", "-H", "-u", registry_user, "--", "docker"]
    return command(prefix + args, 240)

def directory(path, create=False):
    if not path.exists() and not path.is_symlink() and create:
        path.mkdir(mode=0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER_UID and info.st_mode & 0o022 == 0)

def regular(path, uid=0, mode=0o600):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid and stat.S_IMODE(info.st_mode) == mode)

def read_json(path):
    regular(path, OWNER_UID)
    raw = path.read_bytes()
    require(len(raw) <= 512000)
    return json.loads(raw)

def write_bytes(path, data, uid=0, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.chown(path, uid, uid)

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def prepare_candidate(root, files, item):
    # Only the complete, durable candidate acquires the final revision name.
    # A hard interruption may leave an unreferenced private temporary directory.
    with tempfile.TemporaryDirectory(prefix=".candidate-", dir=root.parent) as temporary:
        candidate = pathlib.Path(temporary)
        directory(candidate)
        for name, value in files.items():
            write_bytes(candidate / name, value["content"].encode(), value["uid"], value["mode"])
        write_bytes(candidate / "metadata.json", json.dumps(item, sort_keys=True).encode(), OWNER_UID)
        sync_directory(candidate)
        require(not root.exists() and not root.is_symlink())
        os.rename(candidate, root)
        sync_directory(root.parent)

def save_state():
    target = BASE / "state.json"
    if target.exists() or target.is_symlink():
        regular(target, OWNER_UID)
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=BASE)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(state, file, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
        sync_directory(BASE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def release_path(revision):
    require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{40}", revision))
    return BASE / "releases" / revision

def metadata(revision):
    root = release_path(revision)
    directory(root)
    item = read_json(root / "metadata.json")
    require(item["revision"] == revision and item["project"] == PROJECT)
    require(set(item["files"]) == set(p.name for p in root.iterdir()) - {"metadata.json"})
    for name, description in item["files"].items():
        require(re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", name))
        path = root / name
        regular(path, description["uid"], description["mode"])
        require(hashlib.sha256(path.read_bytes()).hexdigest() == description["sha256"])
    validate_compose_source((root / "compose.yml").read_text(encoding="utf8"))
    return item

def compose(revision, args):
    root = release_path(revision)
    return docker(["compose", "--project-directory", str(root), "--env-file", str(root / "public.env"), "-p", PROJECT, "-f", str(root / "compose.yml")] + args)

def containers():
    ids = docker(["ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT]).splitlines()
    require(len(ids) <= 8 and all(re.fullmatch(r"[a-f0-9]{12,64}", value) for value in ids))
    return json.loads(docker(["inspect"] + ids)) if ids else []

def ownership(revision, item, healthy=False):
    root = release_path(revision)
    actual = containers()
    seen = set()
    for entry in actual:
        labels = entry["Config"]["Labels"]
        service = labels.get("com.docker.compose.service")
        require(service in item["images"] and service not in seen)
        seen.add(service)
        require(labels.get("com.docker.compose.project") == PROJECT)
        require(labels.get("com.docker.compose.project.config_files") == str(root / "compose.yml"))
        require(labels.get("com.docker.compose.project.working_dir") == str(root))
        require(entry["Config"]["Image"] == item["images"][service])
        if healthy:
            require(entry["State"]["Status"] == "running")
            if service == item["healthService"]:
                require(entry["State"].get("Health", {}).get("Status") == "healthy")
    if healthy:
        require(seen == set(item["images"]))

def known_containers(versions):
    seen = set()
    for entry in containers():
        labels = entry["Config"]["Labels"]
        service = labels.get("com.docker.compose.service")
        require(service not in seen)
        seen.add(service)
        require(labels.get("com.docker.compose.project") == PROJECT)
        require(any(service in item["images"] and entry["Config"]["Image"] == item["images"][service] and
            labels.get("com.docker.compose.project.config_files") == str(release_path(revision) / "compose.yml") and
            labels.get("com.docker.compose.project.working_dir") == str(release_path(revision))
            for revision, item in versions.items()))

def validate_compose(revision, item):
    config = json.loads(compose(revision, ["config", "--no-env-resolution", "--format", "json"]))
    require(set(config["services"]) == set(item["images"]))
    require(not config.get("volumes"))
    for network in config.get("networks", {}).values():
        require(not network.get("external") and network.get("name", "").startswith(PROJECT + "_"))
    root = release_path(revision)
    for secret in config.get("secrets", {}).values():
        require(set(secret) <= {"name", "file"})
        path = pathlib.Path(secret["file"])
        require(path.parent == root and path.name in item["files"] and path.name not in ["compose.yml", "public.env"])
    for service, config_service in config["services"].items():
        require(config_service["image"] == item["images"][service])
        for env_file in config_service.get("env_file", []):
            path = pathlib.Path(env_file["path"] if isinstance(env_file, dict) else env_file)
            require(path.parent == root and path.name in item["files"] and path.name not in ["compose.yml", "public.env"])
        require(not any(config_service.get(key) for key in ["build", "ports", "privileged", "container_name", "network_mode", "pid", "ipc", "devices", "cap_add", "volumes", "configs", "volumes_from", "use_api_socket"]))
        require(config_service.get("read_only") is True)
        require("ALL" in config_service.get("cap_drop", []))
        require(any(value in ["no-new-privileges:true", "no-new-privileges"] for value in config_service.get("security_opt", [])))
        require(int(config_service.get("mem_limit", 0)) > 0 and float(config_service.get("cpus", 0)) > 0)

def ensure_images(item, revision):
    root_daemon = docker(["info", "--format", "{{.ID}}"])
    require(root_daemon and root_daemon == docker(["info", "--format", "{{.ID}}"], True))
    for service, image in item["images"].items():
        docker(["pull", "--platform", "linux/amd64", image], True)
        inspected = json.loads(docker(["image", "inspect", image]))
        require(len(inspected) == 1)
        value = inspected[0]
        require(value["Architecture"] == "amd64" and value["Os"] == "linux")
        if service == item["healthService"]:
            require(value["Config"].get("Labels", {}).get("org.opencontainers.image.revision") == revision)

def emit(status, current=None, previous=None):
    print(json.dumps({"version": 1, "state": status, "revision": current, "previous": previous}))

def inspect():
    if state["pending"] or state["status"] == "recovery-required":
        emit("recovery-required", state["current"], state["previous"])
    elif state["current"]:
        try:
            item = metadata(state["current"])
            ownership(state["current"], item, True)
            emit("deployed", state["current"], state["previous"])
        except Exception:
            emit("degraded", state["current"], state["previous"])
    else:
        require(not containers())
        emit("absent")

def recover():
    expected = request["expectedCurrentRevision"]
    target = request["targetRevision"]
    release_path(expected)
    release_path(target)
    require(expected != target and state["status"] == "deployed" and not state["pending"])
    require(state["current"] == expected and state["previous"] == target)
    current_item = metadata(expected)
    previous_item = metadata(target)
    ownership(expected, current_item)
    validate_compose(target, previous_item)
    ensure_images(previous_item, target)
    state["pending"] = target
    save_state()
    try:
        compose(target, ["up", "-d", "--force-recreate", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"])
        ownership(target, previous_item, True)
        state.update(current=target, previous=expected, pending=None, status="deployed")
        save_state()
        emit("deployed", target, expected)
    except Exception:
        state.update(current=expected, previous=target, pending=target, status="recovery-required")
        save_state()
        emit("recovery-required", expected, target)

def deploy():
    require(not state["pending"] and state["status"] != "recovery-required")
    revision = request["revision"]
    old = state["current"]
    previous_before = state["previous"]
    old_item = metadata(old) if old else None
    if old:
        ownership(old, old_item, True)
        validate_compose(old, old_item)
    else:
        require(not containers())
    files = {name: {"content": entry["content"], "uid": entry["uid"], "mode": int(entry["mode"], 8)} for name, entry in request["privateFiles"].items()}
    files["compose.yml"] = {"content": request["composeYaml"], "uid": OWNER_UID, "mode": 0o600}
    files["public.env"] = {"content": "".join(key + "='" + value + "'\n" for key, value in sorted(request["publicEnv"].items())), "uid": OWNER_UID, "mode": 0o600}
    item = {"revision": revision, "project": PROJECT, "images": request["imageDigests"], "healthService": request["healthService"], "files": {name: {"uid": value["uid"], "mode": value["mode"], "sha256": hashlib.sha256(value["content"].encode()).hexdigest()} for name, value in files.items()}}
    root = release_path(revision)
    if root.exists() or root.is_symlink():
        require(metadata(revision) == item)
    else:
        prepare_candidate(root, files, item)
    validate_compose(revision, item)
    if old == revision:
        ownership(revision, item, True)
        emit("deployed", revision, state["previous"])
        return
    ensure_images(item, revision)
    state["pending"] = revision
    save_state()
    try:
        compose(revision, ["up", "-d", "--force-recreate", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"])
        ownership(revision, item, True)
        state.update(current=revision, previous=old, pending=None, status="deployed")
        save_state()
        emit("deployed", revision, old)
    except Exception:
        try:
            known_containers({revision: item, **({old: old_item} if old else {})})
            compose(revision, ["stop"])
            if old:
                compose(old, ["up", "-d", "--force-recreate", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"])
                ownership(old, old_item, True)
            else:
                compose(revision, ["down"])
                require(not containers())
            state.update(current=old, previous=previous_before, pending=None, status="deployed" if old else "absent")
            save_state()
            emit("recovered", old, state["previous"])
        except Exception:
            state.update(status="recovery-required", pending=revision)
            save_state()
            emit("recovery-required", state["current"], state["previous"])

def main():
    require(os.geteuid() == OWNER_UID and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", registry_user))
    require(request["action"] in ["inspect", "deploy", "recover"])
    if request["action"] == "deploy":
        validate_compose_source(request["composeYaml"])
    require(docker(["info", "--format", "{{.Architecture}}"]) in ["x86_64", "amd64"])
    docker(["compose", "version"])
    directory(BASE.parent.parent)
    if BASE.parent.exists() or BASE.parent.is_symlink():
        directory(BASE.parent)
    if request["action"] == "inspect" and not BASE.exists() and not BASE.is_symlink():
        require(not containers())
        emit("absent")
        return
    for path in [BASE.parent, BASE, BASE / "releases"]:
        directory(path, request["action"] == "deploy")
    lock_path = BASE / ".lock"
    if lock_path.exists() or lock_path.is_symlink():
        regular(lock_path, OWNER_UID)
    elif request["action"] == "inspect":
        raise RuntimeError("unverified")
    flags = os.O_RDWR | os.O_NOFOLLOW
    if request["action"] == "deploy":
        flags |= os.O_CREAT
    with os.fdopen(os.open(lock_path, flags, 0o600), "r+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = BASE / "state.json"
        if state_path.exists() or state_path.is_symlink():
            saved = read_json(state_path)
            require(set(saved) == set(state) and saved["status"] in ["absent", "deployed", "recovery-required"])
            for key in ["current", "previous", "pending"]:
                require(saved[key] is None or re.fullmatch(r"[a-f0-9]{40}", saved[key]))
            state.update(saved)
        if request["action"] == "inspect":
            inspect()
        elif request["action"] == "recover":
            recover()
        else:
            deploy()

try:
    main()
except Exception:
    emit("blocked")
`;
