/**
 * secret.ts —— API 密钥的本地安全存储。
 * 使用 Electron safeStorage（Windows DPAPI）加密，存储格式：`safe-storage:v1:<base64>`。
 * 任何列表/响应接口只回传 apiKeySet 布尔值，密钥明文不出主进程。
 */
import { safeStorage } from 'electron'

export const SECRET_PREFIX = 'safe-storage:v1:'

export interface SecretCodec {
  /** 是否可用（Windows 上依赖 DPAPI，一般恒可用） */
  isAvailable(): boolean
  /** 加密明文密钥，返回带前缀的存储串 */
  encrypt(plain: string): string
  /** 解密存储串为明文密钥 */
  decrypt(stored: string): string
}

export const safeStorageCodec: SecretCodec = {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  },
  encrypt(plain: string): string {
    return SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64')
  },
  decrypt(stored: string): string {
    if (!stored.startsWith(SECRET_PREFIX)) throw new Error('密钥存储格式无效，无法解密')
    const buf = Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  }
}
