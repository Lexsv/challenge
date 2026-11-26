// Dedicated D7 items only. Input and secret output use pipes, never command arguments.
import Foundation
import Security
import LocalAuthentication


func finish(_ value: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
    exit(0)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let provider = request["provider"] as? String,

      let action = request["action"] as? String else { finish(["ok": false]) }
let isMcp = provider.range(of: #"^mcp-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"#, options: .regularExpression) != nil
guard isMcp || ["openai", "opencode-console", "opencode-go"].contains(provider) else { finish(["ok": false]) }
let namespace = ProcessInfo.processInfo.environment["DAY18_KEYCHAIN_NAMESPACE"] ?? "local.\(NSUserName()).challenge.d18"
let service = namespace + (isMcp ? ".mcp-credentials.v1" : ".provider-credentials.v1")
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: provider]
if action == "status" {
    var attributes = query
    attributes[kSecReturnAttributes as String] = true
    // Status never asks for password data or prompts to unlock it.
    let context = LAContext()
    context.interactionNotAllowed = true
    attributes[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecSuccess { finish(["ok": true, "saved": true]) }
    if status == errSecItemNotFound { finish(["ok": true, "saved": false]) }
    finish(["ok": false])
}
if action == "save", let key = request["key"] as? String, !key.isEmpty {
    let data = key.data(using: .utf8)!
    var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
    }
    finish(["ok": status == errSecSuccess])
}
if action == "forget" {
    let status = SecItemDelete(query as CFDictionary)
    finish(["ok": status == errSecSuccess || status == errSecItemNotFound])
}
if action == "read" {
    var item = query
    item[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(item as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data,
          let key = String(data: data, encoding: .utf8) else { finish(["ok": false]) }
    finish(["ok": true, "key": key])
}
finish(["ok": false])
