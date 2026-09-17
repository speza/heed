import AppKit
import Carbon.HIToolbox
import WebKit

private func fourCharacterCode(_ value: String) -> OSType {
  value.utf8.reduce(0) { result, character in
    (result << 8) + OSType(character)
  }
}

private let hotKeySignature = fourCharacterCode("HEED")

private func hotKeyEventHandler(
  _: EventHandlerCallRef?,
  _: EventRef?,
  userData: UnsafeMutableRawPointer?
) -> OSStatus {
  guard let userData else { return noErr }
  let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
  DispatchQueue.main.async {
    delegate.togglePanel()
  }
  return noErr
}

final class FloatingPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  // NSPanel treats Escape as cancelOperation by default. The web terminal owns
  // Escape, and Heed is dismissed explicitly with Option+Space or its close UI.
  override func cancelOperation(_: Any?) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
  private var panel: FloatingPanel!
  private var webView: WKWebView!
  private var barEffect: NSVisualEffectView!
  private var drawerEffect: NSVisualEffectView!
  private var hotKeyRef: EventHotKeyRef?
  private var hotKeyHandlerRef: EventHandlerRef?
  private var localCommandMonitor: Any?
  private var currentEdge = "right"
  private var drawerSize: CGSize?

  func applicationDidFinishLaunching(_: Notification) {
    NSApp.setActivationPolicy(.accessory)
    createPanel()
    registerGlobalShortcut()
    registerLocalCommands()
    showPanel()
  }

  func applicationWillTerminate(_: Notification) {
    if let hotKeyRef {
      UnregisterEventHotKey(hotKeyRef)
    }
    if let hotKeyHandlerRef {
      RemoveEventHandler(hotKeyHandlerRef)
    }
    if let localCommandMonitor {
      NSEvent.removeMonitor(localCommandMonitor)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
    false
  }

  func togglePanel() {
    if panel.isVisible {
      webView.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('heed:toggle-main'))",
        completionHandler: nil
      )
    } else {
      showPanel()
    }
  }

  func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "shell",
      let payload = message.body as? [String: Any],
      let type = payload["type"] as? String
    else { return }

    switch type {
    case "hide":
      hidePanel()
    case "toggle":
      togglePanel()
    case "resize":
      guard let width = payload["width"] as? Double,
        let height = payload["height"] as? Double
      else { return }
      currentEdge = payload["edge"] as? String ?? "right"
      if let drawer = payload["drawer"] as? [String: Any],
        let drawerWidth = drawer["width"] as? Double,
        let drawerHeight = drawer["height"] as? Double
      {
        drawerSize = CGSize(width: drawerWidth, height: drawerHeight)
      } else {
        drawerSize = nil
        // Collapse immediately: an out-of-date effect frame can otherwise
        // protrude beside the narrow sidebar until the web commit arrives.
        drawerEffect.isHidden = true
      }
      resizePanel(width: width, height: height, edge: currentEdge)
      // Confirm so the web swaps its layout only once the window can show it.
      webView.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('heed:resized'))",
        completionHandler: nil
      )
    case "commit":
      // The web has swapped to the confirmed geometry. Move or hide the
      // vibrancy surface only now so stale drawer glass cannot remain visible.
      layoutBarSurface()
      layoutDrawerSurface()
    default:
      break
    }
  }

  private func createPanel() {
    panel = FloatingPanel(
      contentRect: NSRect(x: 0, y: 0, width: 68, height: 260),
      styleMask: [.borderless, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.animationBehavior = .utilityWindow
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

    // The window is a transparent stage. Vibrancy lives in shaped surfaces
    // sized to the web content, so the glass never bleeds past what is drawn.
    let container = NSView()
    container.autoresizingMask = [.width, .height]

    barEffect = makeEffectView(cornerRadius: 20)
    drawerEffect = makeEffectView(cornerRadius: 22)
    drawerEffect.isHidden = true

    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, name: "shell")
    configuration.preferences.isElementFullscreenEnabled = false

    webView = WKWebView(frame: container.bounds, configuration: configuration)
    webView.autoresizingMask = [.width, .height]
    webView.setValue(false, forKey: "drawsBackground")
    webView.underPageBackgroundColor = .clear

    container.addSubview(barEffect)
    container.addSubview(drawerEffect)
    container.addSubview(webView)
    panel.contentView = container

    layoutBarSurface()
    layoutDrawerSurface()

    loadWebExperience()
  }

  private func makeEffectView(cornerRadius: CGFloat) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .hudWindow
    view.blendingMode = .behindWindow
    view.state = .active
    view.wantsLayer = true
    view.layer?.cornerRadius = cornerRadius
    view.layer?.masksToBounds = true
    view.translatesAutoresizingMaskIntoConstraints = true
    return view
  }

  private func loadWebExperience() {
    if let developmentURL = ProcessInfo.processInfo.environment["MINIMAL_ADE_DEV_URL"],
      let url = URL(string: developmentURL)
    {
      webView.load(URLRequest(url: url))
      return
    }

    let repository = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let distribution = repository.appendingPathComponent("dist", isDirectory: true)
    let index = distribution.appendingPathComponent("index.html")

    guard FileManager.default.fileExists(atPath: index.path) else {
      webView.loadHTMLString(
        """
        <body style="background:#0d100f;color:#e0e2dc;font:16px -apple-system;padding:32px">
          Build the web experience first with <code>bun run build</code>.
        </body>
        """,
        baseURL: nil
      )
      return
    }

    webView.loadFileURL(index, allowingReadAccessTo: distribution)
  }

  private func registerGlobalShortcut() {
    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    InstallEventHandler(
      GetApplicationEventTarget(),
      hotKeyEventHandler,
      1,
      &eventType,
      UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque()),
      &hotKeyHandlerRef
    )

    let identifier = EventHotKeyID(signature: hotKeySignature, id: 1)
    RegisterEventHotKey(
      UInt32(kVK_Space),
      UInt32(optionKey),
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )
  }

  // Keep the application-level back command reliable without intercepting
  // Escape, control keys or any other input owned by the terminal.
  private func registerLocalCommands() {
    localCommandMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      if event.keyCode == UInt16(kVK_ANSI_W), modifiers == .command {
        self?.webView?.evaluateJavaScript(
          "window.dispatchEvent(new CustomEvent('heed:back'))",
          completionHandler: nil
        )
        return nil
      }
      return event
    }
  }

  private func showPanel() {
    centrePanel()
    layoutBarSurface()
    layoutDrawerSurface()
    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.16
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      panel.animator().alphaValue = 1
    }
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('heed:shown'))")
  }

  private func hidePanel() {
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('heed:hidden'))")
    NSAnimationContext.runAnimationGroup(
      { context in
        context.duration = 0.12
        context.timingFunction = CAMediaTimingFunction(name: .easeIn)
        panel.animator().alphaValue = 0
      },
      completionHandler: { [weak self] in
        Task { @MainActor in
          self?.panel.orderOut(nil)
        }
      }
    )
  }

  private func centrePanel() {
    let mouseLocation = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouseLocation, $0.frame, false) } ?? NSScreen.main
    guard let visibleFrame = screen?.visibleFrame else { return }
    let frame = panel.frame
    if currentEdge == "right" {
      panel.setFrameOrigin(
        NSPoint(
          x: visibleFrame.maxX - frame.width - 8,
          y: visibleFrame.midY - frame.height / 2
        )
      )
      return
    }
    panel.setFrameOrigin(
      NSPoint(
        x: visibleFrame.midX - frame.width / 2,
        y: visibleFrame.minY
      )
    )
  }

  // The web drives sizing. Bottom edge: pinned to the bottom (the AppKit
  // origin is the bottom edge, so it must not move). Right edge: flush with
  // the screen edge and vertically centred, so drawers grow leftward.
  private func resizePanel(width: Double, height: Double, edge: String) {
    let mouseLocation = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouseLocation, $0.frame, false) } ?? NSScreen.main
    let maxVisibleHeight = screen?.visibleFrame.height ?? 760
    let clampedWidth: Double
    let clampedHeight: Double
    if edge == "right" {
      clampedWidth = min(max(width, 40), 1200)
      clampedHeight = min(max(height, 170), min(950, maxVisibleHeight - 30))
    } else {
      clampedWidth = min(max(width, 400), 1200)
      clampedHeight = min(max(height, 40), min(950, maxVisibleHeight - 30))
    }
    var frame = panel.frame
    let oldWidth = frame.width
    frame.size = NSSize(width: clampedWidth, height: clampedHeight)
    if edge == "right" {
      frame.origin.x = (screen?.visibleFrame.maxX ?? 0) - clampedWidth - 8
      frame.origin.y = (screen?.visibleFrame.midY ?? 0) - clampedHeight / 2
    } else {
      frame.origin.x -= (clampedWidth - oldWidth) / 2
    }
    panel.setFrame(frame, display: true)
    layoutBarSurface()
  }

  private func layoutBarSurface() {
    guard let container = panel.contentView else { return }
    let bounds = container.bounds

    // Transparent margins give the CSS shadows room to render; the vibrancy
    // surfaces sit inset by exactly those margins. Frames are set directly:
    // the window snaps, the web springs, and the glass never animates
    // independently of either.
    if currentEdge == "right" {
      barEffect.frame = NSRect(
        x: bounds.width - 8 - 40,
        y: (bounds.height - 204) / 2,
        width: 40,
        height: 204
      )
    } else {
      barEffect.frame = NSRect(x: 28, y: 24, width: bounds.width - 56, height: 40)
    }
    barEffect.layer?.cornerRadius = 20
  }

  private func layoutDrawerSurface() {
    guard let container = panel.contentView else { return }
    let bounds = container.bounds

    guard let size = drawerSize else {
      drawerEffect.isHidden = true
      return
    }

    if currentEdge == "right" {
      // Right-anchored next to the spine, so every drawer size composes in
      // the same constant stage.
      drawerEffect.frame = NSRect(
        x: bounds.width - 8 - 40 - 10 - size.width,
        y: (bounds.height - size.height) / 2,
        width: size.width,
        height: size.height
      )
    } else {
      drawerEffect.frame = NSRect(x: (bounds.width - size.width) / 2, y: 74, width: size.width, height: size.height)
    }
    drawerEffect.layer?.cornerRadius = 22
    drawerEffect.isHidden = false
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
