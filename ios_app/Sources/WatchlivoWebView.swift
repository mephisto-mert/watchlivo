import AuthenticationServices
import AVFoundation
import AVKit
import SafariServices
import SwiftUI
import UIKit
import WebKit

final class WatchlivoBridgeState: ObservableObject {
    let homeURL: URL = URL(string: "https://watchlivo.online/?app=ios")!

    @Published var isInitialLoadComplete: Bool = false
    @Published var isLoading: Bool = true
    @Published var loadErrorMessage: String? = nil
    @Published var pendingURL: URL? = nil
    @Published var pendingRoomId: String? = nil
    @Published var reloadNonce: Int = 0

    func triggerReload() {
        DispatchQueue.main.async {
            self.loadErrorMessage = nil
            self.reloadNonce &+= 1
        }
    }

    func openHome() {
        DispatchQueue.main.async {
            self.loadErrorMessage = nil
            self.pendingRoomId = nil
            self.pendingURL = self.homeURL
        }
    }

    func handleIncomingURL(_ incomingURL: URL) {
        let scheme = incomingURL.scheme?.lowercased() ?? ""
        if scheme == "watchlivo" {
            let host = (incomingURL.host ?? "").lowercased()
            if host == "auth" {
                // Handled directly by ASWebAuthenticationSession when active.
                return
            }
            let comps = URLComponents(url: incomingURL, resolvingAgainstBaseURL: false)
            var roomId = comps?.queryItems?.first(where: { $0.name == "room" })?.value ?? ""
            if roomId.isEmpty {
                let parts = incomingURL.path.split(separator: "/").map(String.init)
                if let first = parts.first, !first.isEmpty {
                    roomId = (first == "r" || first == "room" || first == "mesh") ? (parts.dropFirst().first ?? "") : first
                } else if !host.isEmpty && host != "open" && host != "room" && host != "mesh" && host != "home" {
                    roomId = host
                }
            }
            DispatchQueue.main.async {
                self.loadErrorMessage = nil
                if !roomId.isEmpty {
                    self.pendingRoomId = roomId
                } else {
                    self.pendingURL = self.homeURL
                }
            }
            return
        }

        if scheme == "https", let host = incomingURL.host?.lowercased(),
           (host == "watchlivo.online" || host.hasSuffix(".watchlivo.online")) {
            DispatchQueue.main.async {
                self.loadErrorMessage = nil
                self.pendingURL = incomingURL
            }
        }
    }
}

struct WatchlivoWebView: UIViewRepresentable {
    @ObservedObject var bridge: WatchlivoBridgeState

    private static let messageHandlerNames = [
        "watchlivoHaptic",
        "watchlivoPiP",
        "watchlivoAudioSession",
        "watchlivoShare",
        "watchlivoGoogleAuth"
    ]

    final class ContainerView: UIView {
        let pipLayer = AVPlayerLayer()
        var webView: WKWebView?
        var customPipRect: CGRect?

        override func layoutSubviews() {
            super.layoutSubviews()
            webView?.frame = bounds
            if let rect = customPipRect, rect.width >= 80, rect.height >= 45 {
                pipLayer.frame = rect
            } else if pipLayer.frame.width < 10 || pipLayer.frame.height < 10 {
                let w = max(240, bounds.width)
                pipLayer.frame = CGRect(x: 0, y: 72, width: w, height: round(w * 9.0 / 16.0))
            }
        }
    }

    enum AudioMode: Equatable {
        case none
        case playbackMixed
        case playbackExclusive
        case voiceCall
    }

    final class Coordinator: NSObject,
        WKNavigationDelegate,
        WKUIDelegate,
        WKScriptMessageHandler,
        AVPictureInPictureControllerDelegate,
        ASWebAuthenticationPresentationContextProviding
    {
        var bridge: WatchlivoBridgeState
        weak var webView: WKWebView?
        weak var containerView: ContainerView?

        let pipPlayer = AVPlayer()
        var pipController: AVPictureInPictureController?
        var currentPipUrl: String = ""
        var wantInlineAutoPip: Bool = false
        var inlineUserMuted: Bool = false
        var isLiveStream: Bool = false
        var desiredRate: Float = 1.0
        var audioMode: AudioMode = .none
        var isVoiceSessionActive: Bool = false
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        var lastHandledReloadNonce: Int = 0
        var activeAuthSession: ASWebAuthenticationSession?
        var activeAuthState: String = ""

        init(bridge: WatchlivoBridgeState) {
            self.bridge = bridge
            super.init()
            pipPlayer.isMuted = true
            pipPlayer.allowsExternalPlayback = true
            configureAudioSession(.playbackMixed)

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(onWillResignActive),
                name: UIApplication.willResignActiveNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(onDidBecomeActive),
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
            activeAuthSession?.cancel()
            activeAuthSession = nil
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }

        // MARK: - Audio Session

        func configureAudioSession(_ target: AudioMode) {
            if audioMode == target { return }
            let session = AVAudioSession.sharedInstance()
            do {
                switch target {
                case .none:
                    return
                case .playbackMixed:
                    try session.setCategory(
                        .playback,
                        mode: .moviePlayback,
                        options: [.allowAirPlay, .allowBluetoothA2DP, .mixWithOthers]
                    )
                case .playbackExclusive:
                    try session.setCategory(
                        .playback,
                        mode: .moviePlayback,
                        options: [.allowAirPlay, .allowBluetoothA2DP]
                    )
                case .voiceCall:
                    try session.setCategory(
                        .playAndRecord,
                        mode: .voiceChat,
                        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
                    )
                }
                try session.setActive(true)
                audioMode = target
            } catch {
                // Keep previous mode if iOS refuses transient audio session switch.
            }
        }

        // MARK: - App Lifecycle & Auto-PiP

        @objc func onWillResignActive() {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
            bgTask = UIApplication.shared.beginBackgroundTask(withName: "WatchlivoPiPTransition") { [weak self] in
                guard let self = self else { return }
                if self.bgTask != .invalid {
                    UIApplication.shared.endBackgroundTask(self.bgTask)
                    self.bgTask = .invalid
                }
            }
            if wantInlineAutoPip && !isVoiceSessionActive {
                configureAudioSession(.playbackExclusive)
            }
            webView?.evaluateJavaScript(
                "window.__onWatchlivoAppState && window.__onWatchlivoAppState('willResignActive');",
                completionHandler: nil
            )
            if wantInlineAutoPip,
               let ctrl = pipController,
               !ctrl.isPictureInPictureActive,
               let item = pipPlayer.currentItem
            {
                item.preferredPeakBitRate = 0
                item.preferredForwardBufferDuration = 0
                pipPlayer.isMuted = inlineUserMuted
                if pipPlayer.rate <= 0.01 && item.status == .readyToPlay {
                    pipPlayer.playImmediately(atRate: desiredRate > 0 ? desiredRate : 1.0)
                }
                if ctrl.isPictureInPicturePossible {
                    ctrl.startPictureInPicture()
                }
            }
        }

        @objc func onDidBecomeActive() {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
            if !(pipController?.isPictureInPictureActive ?? false) {
                configureAudioSession(isVoiceSessionActive ? .voiceCall : .playbackMixed)
            }
            webView?.evaluateJavaScript(
                "window.__onWatchlivoAppState && window.__onWatchlivoAppState('didBecomeActive');",
                completionHandler: nil
            )
        }

        // MARK: - Helpers

        func isTrustedWatchlivoHost(_ host: String?) -> Bool {
            guard let h = host?.lowercased(), !h.isEmpty else { return false }
            return h == "watchlivo.online" || h.hasSuffix(".watchlivo.online")
        }

        func isAllowedInWebViewHost(_ host: String?) -> Bool {
            guard let h = host?.lowercased(), !h.isEmpty else { return false }
            if isTrustedWatchlivoHost(h) { return true }
            let authHosts = [
                "watchlivo-38ab6.firebaseapp.com",
                "accounts.google.com",
                "apis.google.com",
                "www.googleapis.com",
                "identitytoolkit.googleapis.com",
                "securetoken.googleapis.com"
            ]
            return authHosts.contains(h)
        }

        func encodeJSON(_ object: Any) -> String? {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object, options: []),
                  let str = String(data: data, encoding: .utf8)
            else { return nil }
            return str
        }

        func topMostViewController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let windows = scenes.flatMap { $0.windows }
            let root = windows.first(where: { $0.isKeyWindow })?.rootViewController ?? windows.first?.rootViewController
            var top = root
            while let presented = top?.presentedViewController {
                top = presented
            }
            return top
        }

        func presentSafari(url: URL) {
            DispatchQueue.main.async {
                guard let presenter = self.topMostViewController() else {
                    UIApplication.shared.open(url)
                    return
                }
                let safari = SFSafariViewController(url: url)
                safari.preferredBarTintColor = UIColor(red: 0.035, green: 0.047, blue: 0.082, alpha: 1.0)
                safari.preferredControlTintColor = UIColor(red: 0.0, green: 0.96, blue: 0.83, alpha: 1.0)
                safari.dismissButtonStyle = .close
                presenter.present(safari, animated: true)
            }
        }

        func navigateToRoom(_ roomId: String) {
            guard let webView = webView else { return }
            let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            if let json = encodeJSON(["roomId": trimmed]) {
                let js = """
                (function(p){
                  if (typeof window.vortexNavigate === 'function') {
                    window.vortexNavigate('/mesh/' + encodeURIComponent(p.roomId));
                    return true;
                  }
                  return false;
                })(\(json));
                """
                webView.evaluateJavaScript(js) { [weak self] result, _ in
                    if (result as? Bool) == true { return }
                    guard let self = self else { return }
                    let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmed
                    if let fallback = URL(string: "https://watchlivo.online/?app=ios#/mesh/\(encoded)") {
                        self.webView?.load(URLRequest(url: fallback))
                    }
                }
            }
        }

        // MARK: - Native PiP Engine

        func syncOrStartPiP(_ body: [String: Any], forceStart: Bool) {
            guard let urlStr = body["url"] as? String,
                  !urlStr.isEmpty,
                  let u = URL(string: urlStr),
                  let sc = u.scheme?.lowercased(),
                  (sc == "https" || sc == "http")
            else { return }

            inlineUserMuted = (body["muted"] as? Bool) ?? false
            isLiveStream = (body["live"] as? Bool) ?? false
            let playing = (body["playing"] as? Bool) ?? true
            let sec = (body["time"] as? Double) ?? 0.0
            let rate = max(0.25, Float((body["rate"] as? Double) ?? 1.0))
            desiredRate = rate

            if let vol = body["volume"] as? Double {
                pipPlayer.volume = Float(max(0.0, min(1.0, vol)))
            }

            if let rectDict = body["rect"] as? [String: Any],
               let x = rectDict["x"] as? Double,
               let y = rectDict["y"] as? Double,
               let w = rectDict["width"] as? Double,
               let h = rectDict["height"] as? Double,
               w >= 80, h >= 45
            {
                let frame = CGRect(x: x, y: y, width: w, height: h)
                containerView?.customPipRect = frame
                containerView?.pipLayer.frame = frame
            }

            if urlStr != currentPipUrl {
                currentPipUrl = urlStr
                let asset = AVURLAsset(url: u)
                let item = AVPlayerItem(asset: asset)
                item.preferredPeakBitRate = (pipController?.isPictureInPictureActive == true) ? 0 : 750_000
                item.preferredForwardBufferDuration = 4.0
                pipPlayer.replaceCurrentItem(with: item)
            }

            if forceStart {
                if pipController?.isPictureInPictureActive == true {
                    pipController?.stopPictureInPicture()
                    return
                }
                wantInlineAutoPip = true
                configureAudioSession(.playbackExclusive)
                pipPlayer.currentItem?.preferredPeakBitRate = 0
                pipPlayer.isMuted = inlineUserMuted
                if !isLiveStream && sec > 0.25 {
                    pipPlayer.seek(
                        to: CMTime(seconds: sec, preferredTimescale: 600),
                        toleranceBefore: .zero,
                        toleranceAfter: .zero
                    )
                }
                pipPlayer.playImmediately(atRate: rate)
                pipController?.startPictureInPicture()
                return
            }

            wantInlineAutoPip = playing
            if pipController?.isPictureInPictureActive == true {
                pipPlayer.isMuted = inlineUserMuted
                return
            }
            pipPlayer.isMuted = true
            if !isLiveStream && sec > 0.5 {
                let cur = pipPlayer.currentTime().seconds
                if cur.isFinite && abs(cur - sec) > 6.0 {
                    let tol = CMTime(seconds: 1.0, preferredTimescale: 600)
                    pipPlayer.seek(
                        to: CMTime(seconds: sec, preferredTimescale: 600),
                        toleranceBefore: tol,
                        toleranceAfter: tol
                    )
                }
            }
            if playing {
                if !isVoiceSessionActive {
                    configureAudioSession(.playbackMixed)
                }
                if abs(pipPlayer.rate - rate) > 0.05 {
                    pipPlayer.playImmediately(atRate: rate)
                }
            } else {
                pipPlayer.pause()
            }
        }

        func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
            configureAudioSession(.playbackExclusive)
            pipPlayer.currentItem?.preferredPeakBitRate = 0
            pipPlayer.isMuted = inlineUserMuted
            if pipPlayer.rate <= 0.01 {
                pipPlayer.playImmediately(atRate: desiredRate > 0 ? desiredRate : 1.0)
            }
            webView?.evaluateJavaScript(
                "window.__onWatchlivoNativePiP && window.__onWatchlivoNativePiP({state:'started'});",
                completionHandler: nil
            )
        }

        func pictureInPictureController(
            _ pictureInPictureController: AVPictureInPictureController,
            restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
        ) {
            DispatchQueue.main.async {
                completionHandler(true)
            }
        }

        func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
            let t = pipPlayer.currentTime().seconds
            let safeT = (t.isFinite && t >= 0) ? t : 0
            let appActive = (UIApplication.shared.applicationState == .active)
            pipPlayer.isMuted = true
            pipPlayer.currentItem?.preferredPeakBitRate = 750_000
            if appActive {
                configureAudioSession(isVoiceSessionActive ? .voiceCall : .playbackMixed)
            } else {
                pipPlayer.pause()
                wantInlineAutoPip = false
            }
            let js = String(
                format: "window.__onWatchlivoNativePiP && window.__onWatchlivoNativePiP({state:'stopped',time:%.3f,playing:%@});",
                safeT,
                appActive ? "true" : "false"
            )
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        // MARK: - Native Google Auth (ASWebAuthenticationSession)

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let windows = scenes.flatMap { $0.windows }
            if let key = windows.first(where: { $0.isKeyWindow }) {
                return key
            }
            if let first = windows.first {
                return first
            }
            return ASPresentationAnchor()
        }

        func startNativeGoogleAuth(callbackId: String, loginHint: String) {
            let state = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            activeAuthState = state
            activeAuthSession?.cancel()
            activeAuthSession = nil

            var comps = URLComponents(string: "https://watchlivo.online/desktop-auth.html")!
            var items: [URLQueryItem] = [
                URLQueryItem(name: "mode", value: "ios"),
                URLQueryItem(name: "state", value: state)
            ]
            if !loginHint.isEmpty {
                items.append(URLQueryItem(name: "login_hint", value: loginHint))
            }
            comps.queryItems = items

            guard let authURL = comps.url else {
                deliverAuthResult(callbackId: callbackId, payload: ["ok": false, "error": "Geçersiz giriş bağlantısı."])
                return
            }

            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: "watchlivo"
            ) { [weak self] callbackURL, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.activeAuthSession = nil
                    let expectedState = self.activeAuthState
                    self.activeAuthState = ""

                    if let error = error {
                        let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                        self.deliverAuthResult(
                            callbackId: callbackId,
                            payload: [
                                "ok": false,
                                "cancelled": cancelled,
                                "error": cancelled ? "İptal edildi." : error.localizedDescription
                            ]
                        )
                        return
                    }

                    guard let cb = callbackURL,
                          let cbComps = URLComponents(url: cb, resolvingAgainstBaseURL: false)
                    else {
                        self.deliverAuthResult(callbackId: callbackId, payload: ["ok": false, "error": "Giriş yanıtı alınamadı."])
                        return
                    }

                    let returnedState = cbComps.queryItems?.first(where: { $0.name == "state" })?.value ?? ""
                    let token = cbComps.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
                    guard !expectedState.isEmpty, returnedState == expectedState, !token.isEmpty else {
                        self.deliverAuthResult(callbackId: callbackId, payload: ["ok": false, "error": "Güvenlik doğrulaması eşleşmedi."])
                        return
                    }

                    self.deliverAuthResult(callbackId: callbackId, payload: ["ok": true, "token": token])
                }
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            activeAuthSession = session
            if !session.start() {
                activeAuthSession = nil
                deliverAuthResult(callbackId: callbackId, payload: ["ok": false, "error": "Apple oturum penceresi başlatılamadı."])
            }
        }

        private func deliverAuthResult(callbackId: String, payload: [String: Any]) {
            var full = payload
            full["id"] = callbackId
            guard let json = encodeJSON(full) else { return }
            webView?.evaluateJavaScript(
                "window.__onWatchlivoNativeGoogleAuth && window.__onWatchlivoNativeGoogleAuth(\(json));",
                completionHandler: nil
            )
        }

        // MARK: - Native Haptics & Share

        func triggerHaptic(style: String) {
            switch style.lowercased() {
            case "light":
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "heavy":
                UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            case "soft":
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            case "rigid":
                UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
            case "selection":
                UISelectionFeedbackGenerator().selectionChanged()
            case "success":
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning":
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case "error":
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            default:
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            }
        }

        func presentShareSheet(_ body: [String: Any]) {
            var items: [Any] = []
            if let text = body["text"] as? String, !text.isEmpty {
                items.append(text)
            } else if let title = body["title"] as? String, !title.isEmpty {
                items.append(title)
            }
            if let urlStr = body["url"] as? String, let u = URL(string: urlStr) {
                items.append(u)
            }
            guard !items.isEmpty else { return }

            DispatchQueue.main.async {
                guard let presenter = self.topMostViewController() else { return }
                let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
                if let pop = vc.popoverPresentationController {
                    pop.sourceView = presenter.view
                    pop.sourceRect = CGRect(
                        x: presenter.view.bounds.midX,
                        y: presenter.view.bounds.midY,
                        width: 1,
                        height: 1
                    )
                    pop.permittedArrowDirections = []
                }
                presenter.present(vc, animated: true)
            }
        }

        // MARK: - WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  origin.`protocol`.lowercased() == "https",
                  isTrustedWatchlivoHost(origin.host)
            else { return }

            switch message.name {
            case "watchlivoHaptic":
                let style = (message.body as? String) ?? "medium"
                triggerHaptic(style: style)

            case "watchlivoPiP":
                guard let body = message.body as? [String: Any] else { return }
                let act = (body["action"] as? String) ?? ""
                switch act {
                case "start", "toggle":
                    syncOrStartPiP(body, forceStart: true)
                case "sync":
                    syncOrStartPiP(body, forceStart: false)
                case "pause":
                    wantInlineAutoPip = false
                    if !(pipController?.isPictureInPictureActive ?? false) {
                        pipPlayer.pause()
                    }
                case "stop":
                    wantInlineAutoPip = false
                    if pipController?.isPictureInPictureActive == true {
                        pipController?.stopPictureInPicture()
                    }
                    pipPlayer.pause()
                default:
                    break
                }

            case "watchlivoAudioSession":
                let modeStr: String
                if let body = message.body as? [String: Any] {
                    modeStr = (body["mode"] as? String ?? "").lowercased()
                } else {
                    modeStr = (message.body as? String ?? "").lowercased()
                }
                if modeStr == "playandrecord" || modeStr == "voice" || modeStr == "call" {
                    isVoiceSessionActive = true
                    configureAudioSession(.voiceCall)
                } else {
                    isVoiceSessionActive = false
                    if !(pipController?.isPictureInPictureActive ?? false) {
                        configureAudioSession(.playbackMixed)
                    }
                }

            case "watchlivoShare":
                if let body = message.body as? [String: Any] {
                    presentShareSheet(body)
                }

            case "watchlivoGoogleAuth":
                if let body = message.body as? [String: Any] {
                    let callbackId = (body["id"] as? String) ?? UUID().uuidString
                    let loginHint = (body["loginHint"] as? String) ?? ""
                    startNativeGoogleAuth(callbackId: callbackId, loginHint: loginHint)
                }

            default:
                break
            }
        }

        // MARK: - WKNavigationDelegate

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let scheme = (url.scheme ?? "").lowercased()

            if scheme == "watchlivo" {
                bridge.handleIncomingURL(url)
                decisionHandler(.cancel)
                return
            }

            if scheme == "tel" || scheme == "mailto" || scheme == "itms-services" || scheme == "sms" {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            if scheme == "about" || scheme == "blob" || scheme == "data" || scheme == "javascript" {
                decisionHandler(.allow)
                return
            }

            // Always allow subframes (YouTube, cinema stream iframes, turnstile/auth embeds).
            if let targetFrame = navigationAction.targetFrame, !targetFrame.isMainFrame {
                decisionHandler(.allow)
                return
            }

            // Popup / target="_blank" links on main frame
            if navigationAction.targetFrame == nil {
                if isTrustedWatchlivoHost(url.host) {
                    webView.load(navigationAction.request)
                } else if scheme == "https" || scheme == "http" {
                    presentSafari(url: url)
                }
                decisionHandler(.cancel)
                return
            }

            if scheme == "https" || scheme == "http" {
                if isAllowedInWebViewHost(url.host) {
                    decisionHandler(.allow)
                    return
                }
                if navigationAction.navigationType == .linkActivated {
                    presentSafari(url: url)
                    decisionHandler(.cancel)
                    return
                }
            }

            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.bridge.isLoading = true
                self.bridge.loadErrorMessage = nil
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.bridge.isLoading = false
                self.bridge.isInitialLoadComplete = true
                self.bridge.loadErrorMessage = nil
            }
        }

        private func handleNavigationError(_ error: Error) {
            let nsErr = error as NSError
            // Ignore benign cancellations & WebKit policy redirects (102)
            if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
            if nsErr.domain == "WebKitErrorDomain" && (nsErr.code == 102 || nsErr.code == 204) { return }
            DispatchQueue.main.async {
                self.bridge.isLoading = false
                self.bridge.isInitialLoadComplete = true
                self.bridge.loadErrorMessage = "Watchlivo sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin."
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: - WKUIDelegate

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                if isTrustedWatchlivoHost(url.host) {
                    webView.load(navigationAction.request)
                } else if let sc = url.scheme?.lowercased(), (sc == "https" || sc == "http") {
                    presentSafari(url: url)
                }
            }
            return nil
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            DispatchQueue.main.async {
                guard let presenter = self.topMostViewController() else {
                    completionHandler()
                    return
                }
                let alert = UIAlertController(title: "Watchlivo", message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler() })
                presenter.present(alert, animated: true)
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            DispatchQueue.main.async {
                guard let presenter = self.topMostViewController() else {
                    completionHandler(false)
                    return
                }
                let alert = UIAlertController(title: "Watchlivo", message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel) { _ in completionHandler(false) })
                alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler(true) })
                presenter.present(alert, animated: true)
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            DispatchQueue.main.async {
                guard let presenter = self.topMostViewController() else {
                    completionHandler(nil)
                    return
                }
                let alert = UIAlertController(title: "Watchlivo", message: prompt, preferredStyle: .alert)
                alert.addTextField { tf in
                    tf.text = defaultText
                }
                alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel) { _ in completionHandler(nil) })
                alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in
                    completionHandler(alert.textFields?.first?.text)
                })
                presenter.present(alert, animated: true)
            }
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let trusted = origin.`protocol`.lowercased() == "https"
                && isTrustedWatchlivoHost(origin.host)
                && frame.isMainFrame
            if trusted && (type == .microphone || type == .cameraAndMicrophone) {
                isVoiceSessionActive = true
                configureAudioSession(.voiceCall)
            }
            decisionHandler(trusted ? .grant : .deny)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge)
    }

    func makeUIView(context: Context) -> ContainerView {
        let bgColor = UIColor(red: 0.035, green: 0.047, blue: 0.082, alpha: 1.0)
        let container = ContainerView(frame: .zero)
        container.backgroundColor = bgColor

        container.pipLayer.player = context.coordinator.pipPlayer
        container.pipLayer.videoGravity = .resizeAspect
        container.layer.addSublayer(container.pipLayer)

        if AVPictureInPictureController.isPictureInPictureSupported() {
            let src = AVPictureInPictureController.ContentSource(playerLayer: container.pipLayer)
            let ctrl = AVPictureInPictureController(contentSource: src)
            ctrl.delegate = context.coordinator
            ctrl.canStartPictureInPictureAutomaticallyFromInline = true
            context.coordinator.pipController = ctrl
        }

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences = preferences
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "Version/17.4 Mobile/15E148 Safari/604.1 WatchlivoIOS/2.2.10"

        let bridgeScript = """
        (function() {
          window.isWatchlivoNativeIOS = true;
          window.watchlivoNativeVersion = '2.2.10';
          window.triggerHaptic = function(s) {
            try { window.webkit.messageHandlers.watchlivoHaptic.postMessage(String(s || 'medium')); } catch(e) {}
          };
          window.watchlivoNativePiP = function(action, payload) {
            try {
              var msg = Object.assign({ action: String(action || '') }, payload || {});
              window.webkit.messageHandlers.watchlivoPiP.postMessage(msg);
              return true;
            } catch(e) { return false; }
          };
          window.watchlivoNativeAudioSession = function(mode) {
            try {
              window.webkit.messageHandlers.watchlivoAudioSession.postMessage({ mode: String(mode || 'playback') });
              return true;
            } catch(e) { return false; }
          };
          window.watchlivoNativeShare = function(payload) {
            try {
              window.webkit.messageHandlers.watchlivoShare.postMessage(payload || {});
              return true;
            } catch(e) { return false; }
          };
          var _authPending = {};
          var _authSeq = 0;
          window.__onWatchlivoNativeGoogleAuth = function(res) {
            try {
              var id = res && res.id;
              var cb = id && _authPending[id];
              if (cb) {
                delete _authPending[id];
                cb(res);
              }
            } catch(e) {}
          };
          window.watchlivoNativeGoogleAuth = function(opts) {
            return new Promise(function(resolve) {
              var id = 'wl_auth_' + (++_authSeq) + '_' + Date.now();
              var timer = setTimeout(function() {
                if (_authPending[id]) {
                  delete _authPending[id];
                  resolve({ ok: false, cancelled: false, error: 'Zaman aşımı.' });
                }
              }, 120000);
              _authPending[id] = function(res) {
                clearTimeout(timer);
                resolve(res || { ok: false });
              };
              try {
                window.webkit.messageHandlers.watchlivoGoogleAuth.postMessage({
                  id: id,
                  loginHint: String((opts && opts.loginHint) || '')
                });
              } catch(e) {
                clearTimeout(timer);
                delete _authPending[id];
                resolve({ ok: false, error: 'Native auth köprüsü başlatılamadı.' });
              }
            });
          };
        })();
        """

        config.userContentController.addUserScript(
            WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        for name in Self.messageHandlerNames {
            config.userContentController.add(context.coordinator, name: name)
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        container.addSubview(webView)
        container.webView = webView
        context.coordinator.webView = webView
        context.coordinator.containerView = container

        let bridgeRef = bridge
        let initialURL: URL
        if let roomId = bridgeRef.pendingRoomId, !roomId.isEmpty {
            let encoded = roomId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? roomId
            initialURL = URL(string: "https://watchlivo.online/?app=ios#/mesh/\(encoded)") ?? bridgeRef.homeURL
            DispatchQueue.main.async { bridgeRef.pendingRoomId = nil }
        } else if let pending = bridgeRef.pendingURL {
            initialURL = pending
            DispatchQueue.main.async { bridgeRef.pendingURL = nil }
        } else {
            initialURL = bridgeRef.homeURL
        }
        webView.load(URLRequest(url: initialURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        return container
    }

    func updateUIView(_ uiView: ContainerView, context: Context) {
        let bridgeRef = bridge
        context.coordinator.bridge = bridgeRef

        if let roomId = bridgeRef.pendingRoomId, !roomId.isEmpty {
            context.coordinator.navigateToRoom(roomId)
            DispatchQueue.main.async {
                bridgeRef.pendingRoomId = nil
            }
        } else if let nextURL = bridgeRef.pendingURL {
            if uiView.webView?.url != nextURL {
                uiView.webView?.load(URLRequest(url: nextURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
            }
            DispatchQueue.main.async {
                bridgeRef.pendingURL = nil
            }
        }

        if bridgeRef.reloadNonce != context.coordinator.lastHandledReloadNonce {
            context.coordinator.lastHandledReloadNonce = bridgeRef.reloadNonce
            if uiView.webView?.url != nil {
                uiView.webView?.reload()
            } else {
                uiView.webView?.load(URLRequest(url: bridgeRef.homeURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
            }
        }
    }

    static func dismantleUIView(_ uiView: ContainerView, coordinator: Coordinator) {
        for name in messageHandlerNames {
            uiView.webView?.configuration.userContentController.removeScriptMessageHandler(forName: name)
        }
        coordinator.pipController?.stopPictureInPicture()
        coordinator.pipPlayer.pause()
        coordinator.activeAuthSession?.cancel()
    }
}
