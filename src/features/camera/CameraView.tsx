import { useEffect, useRef, useState } from "react";
import { FlipHorizontal, VideoCamera, VideoCameraSlash } from "@phosphor-icons/react";
import { HeaderActions, HeaderButton, activeTool } from "../../notch/header";
import { windowShell } from "../../platform/services";
import { settings, updateSettings, type Settings } from "../../settings/store";
import { Empty, Select } from "../../ui/controls";
import { t } from "../../i18n";
import { cameraProblem, type CameraProblem } from "./problem";

const setCamera = (patch: Partial<Settings["camera"]>) => updateSettings((s) => ({ camera: { ...s.camera, ...patch } }));

/*
 * Camera: a mirror to check hair and light before a call. The picture stays in this view; nothing is
 * recorded or sent. The camera runs only while the tool is on screen: switching tools, closing the
 * notch (the view unmounts) or hiding the window stops every track.
 */
export function CameraView() {
  const cfg = settings.use().camera;
  const onScreen = activeTool.use() === "camera";
  const [hidden, setHidden] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const on = onScreen && !hidden;

  useEffect(() => windowShell.onHidden(setHidden), []);

  useEffect(() => {
    if (!on) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem("none");
      return;
    }
    let stream: MediaStream | null = null;
    let gone = false;
    const stop = (s: MediaStream) => s.getTracks().forEach((track) => track.stop());
    // `ideal`, not `exact`: a remembered camera that was unplugged falls back to another one.
    const constraints = { video: cfg.deviceId ? { deviceId: { ideal: cfg.deviceId } } : true, audio: false };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(async (s) => {
        if (gone) return stop(s);
        stream = s;
        if (video.current) video.current.srcObject = s;
        setProblem(null);
        // Device names are only readable once access was granted.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!gone) setCams(all.filter((d) => d.kind === "videoinput"));
      })
      .catch((e: unknown) => !gone && setProblem(cameraProblem(e)));
    return () => {
      gone = true;
      if (stream) stop(stream);
      if (video.current) video.current.srcObject = null;
    };
  }, [on, cfg.deviceId]);

  const current = cams.some((c) => c.deviceId === cfg.deviceId) ? cfg.deviceId : (cams[0]?.deviceId ?? "");

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-3">
      <HeaderActions>
        {cams.length > 1 && (
          <Select
            value={current}
            width="w-40"
            options={cams.map((c, i) => ({ value: c.deviceId, label: c.label || t("Kamera {n}", { n: i + 1 }) }))}
            onChange={(deviceId) => setCamera({ deviceId })}
          />
        )}
        <HeaderButton label={t("Spiegeln")} active={cfg.mirror} onClick={() => setCamera({ mirror: !cfg.mirror })}>
          <FlipHorizontal size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[12px] bg-fill-1">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label={t("Kamera")}
          className="h-full w-full object-cover"
          style={{ transform: cfg.mirror ? "scaleX(-1)" : undefined, visibility: problem ? "hidden" : undefined }}
        />
        {problem && (
          <div className="absolute inset-0">
            <ProblemNote problem={problem} />
          </div>
        )}
      </div>
    </div>
  );
}

function ProblemNote({ problem }: { problem: CameraProblem }) {
  if (problem === "none") return <Empty icon={VideoCameraSlash} title={t("Keine Kamera gefunden")} />;
  if (problem === "denied")
    return <Empty icon={VideoCameraSlash} title={t("Kein Zugriff auf die Kamera")} text={t("In den Windows-Einstellungen unter Datenschutz und Sicherheit, Kamera erlauben")} />;
  if (problem === "busy") return <Empty icon={VideoCamera} title={t("Kamera belegt")} text={t("Eine andere App benutzt die Kamera gerade")} />;
  return <Empty icon={VideoCameraSlash} title={t("Kamera nicht verfügbar")} />;
}
