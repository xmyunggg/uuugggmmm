export {};
export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  username?: string;
  /** 微信 openid；存在即表示该账号可用长期凭证自动刷新登录 code */
  wxid?: string;
  /** 应用宝 PC 登录凭据，用于换发小游戏登录 code（敏感，不对外返回） */
  loginBuffer?: string;
  accesstoken?: string;
  refreshtoken?: string;
  credentialUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
