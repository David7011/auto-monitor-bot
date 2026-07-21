export type ListingSource = "AUTO_RIA" | "OLX" | "RST" | "CARS_UA" | "AUTOMOTO" | "MOCK";

export type TimestampConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type ListingDiscoveryLane = "REALTIME" | "BACKFILL" | "MANUAL";

export type ListingSkipReason =
  | "UNKNOWN_PUBLICATION_DATE"
  | "INVALID_PUBLICATION_DATE"
  | "PUBLICATION_TIME_DAY_ONLY"
  | "FRESHNESS_BY_FIRST_SEEN"
  | "PRICE_NORMALIZATION_UNAVAILABLE";

export type NormalizedListing = {
  source: ListingSource;
  externalId: string;
  url: string;
  canonicalUrl: string;

  title?: string;
  brand?: string;
  model?: string;
  bodyType?: string;
  fuelType?: string;
  gearbox?: string;
  driveType?: string;
  color?: string;
  engineVolume?: number;
  enginePower?: number;
  doors?: number;
  seats?: number;
  condition?: string;
  customsCleared?: boolean;
  bargainPossible?: boolean;
  year?: number;

  priceOriginal?: number;
  currencyOriginal?: string;
  priceNormalized?: number;
  exchangeRateUsed?: number;
  exchangeRateDate?: Date;

  mileage?: number;
  city?: string;
  region?: string;
  sellerPhone?: string;
  vin?: string;
  plateNormalized?: string;

  description?: string;
  photoUrls: string[];

  publishedAt?: Date;
  refreshedAt?: Date;
  timestampConfidence?: TimestampConfidence;
  freshnessFallback?: "FIRST_SEEN";
  skipReason?: ListingSkipReason;
  firstSeenAt: Date;

  raw: unknown;
};

export type ListingStatus = "NEW" | "MATCHED" | "SENT" | "ENRICHED" | "IGNORED" | "DUPLICATE";

export type ListingDto = {
  id: string;
  source: ListingSource;
  externalId: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  bodyType: string | null;
  fuelType: string | null;
  gearbox: string | null;
  driveType: string | null;
  color: string | null;
  engineVolume: number | null;
  enginePower: number | null;
  doors: number | null;
  seats: number | null;
  condition: string | null;
  customsCleared: boolean | null;
  bargainPossible: boolean | null;
  year: number | null;
  priceOriginal: number | null;
  currencyOriginal: string | null;
  priceNormalized: number | null;
  exchangeRateUsed: number | null;
  exchangeRateDate: string | null;
  mileage: number | null;
  city: string | null;
  region: string | null;
  sellerPhone: string | null;
  vin: string | null;
  plateNormalized: string | null;
  description: string | null;
  photoUrls: string[];
  publishedAt: string | null;
  refreshedAt: string | null;
  timestampConfidence: TimestampConfidence;
  skipReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  discoveryLane: ListingDiscoveryLane;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
  vehicleCheck?: VehicleCheckDto | null;
  marketPriceEstimate?: MarketPriceEstimateDto | null;
  telegramNotification?: TelegramNotificationDto | null;
};

export type VehicleCheckStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "NO_PLATE_OR_VIN_FOUND"
  | "PLATE_FOUND"
  | "VIN_FOUND"
  | "CHECK_DONE"
  | "CHECK_PARTIAL"
  | "CHECK_FAILED";

export type VehicleCheckDto = {
  id: string;
  listingId: string;
  plateRaw: string | null;
  plateNormalized: string | null;
  vin: string | null;
  checkStatus: VehicleCheckStatus;
  make: string | null;
  model: string | null;
  year: number | null;
  engineVolume: number | null;
  fuelType: string | null;
  bodyType: string | null;
  driveType: string | null;
  color: string | null;
  mileage: number | null;
  accidents: string | null;
  restrictions: string | null;
  provider: string | null;
  discrepancies: string[];
  createdAt: string;
  updatedAt: string;
};

export type MarketPriceStatus = "READY" | "INSUFFICIENT_DATA" | "FAILED";

export type MarketPriceVerdict = "UNKNOWN" | "HIGH_RISK_BARGAIN" | "BELOW_MARKET" | "FAIR" | "ABOVE_MARKET";

export type MarketPriceEstimateDto = {
  id: string;
  listingId: string;
  status: MarketPriceStatus;
  verdict: MarketPriceVerdict;
  targetPrice: number | null;
  sampleSize: number;
  averagePrice: number | null;
  medianPrice: number | null;
  q1Price: number | null;
  q3Price: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  fairLowPrice: number | null;
  fairHighPrice: number | null;
  currency: string;
  sources: ListingSource[];
  params: unknown;
  createdAt: string;
  updatedAt: string;
};

export type TelegramNotificationStatus = "PENDING" | "PROCESSING" | "RETRY_PENDING" | "SENT" | "UPDATED" | "FAILED";

export type TelegramNotificationDto = {
  id: string;
  listingId: string;
  chatId: string;
  messageId: string | null;
  status: TelegramNotificationStatus;
  lastText: string | null;
  attemptCount: number;
  processingStartedAt: string | null;
  lastAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sentAt: string | null;
  updatedAt: string;
};
