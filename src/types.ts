// LinkedIn API response types

export interface LinkedInProfile {
  id: string;
  localizedFirstName: string;
  localizedLastName: string;
  localizedHeadline?: string;
  vanityName?: string;
  profilePicture?: {
    displayImage: string;
  };
}

export interface LinkedInPost {
  id: string;
  author: string;
  commentary?: string;
  visibility: string;
  lifecycleState: string;
  createdAt?: number;
  lastModifiedAt?: number;
  distribution?: {
    feedDistribution: string;
  };
  content?: {
    media?: {
      id: string;
      title?: string;
    };
  };
}

export interface LinkedInPosition {
  id?: number;
  title: string;
  companyName?: string;
  locationName?: string;
  startMonthYear?: {
    month: number;
    year: number;
  };
  endMonthYear?: {
    month: number;
    year: number;
  };
  current?: boolean;
  description?: string;
}

export interface LinkedInOrgAnalytics {
  organizationalEntity: string;
  totalPageStatistics?: {
    views?: {
      allPageViews?: { pageViews: number };
      mobilePageViews?: { pageViews: number };
      desktopPageViews?: { pageViews: number };
    };
    clicks?: {
      mobileCustomButtonClickCounts?: Array<{ customButtonType: string; clicks: number }>;
      desktopCustomButtonClickCounts?: Array<{ customButtonType: string; clicks: number }>;
    };
  };
  timeRange?: {
    start: number;
    end: number;
  };
}

export interface LinkedInPostAnalytics {
  ugcPostShare?: string;
  totalShareStatistics?: {
    impressionCount: number;
    clickCount: number;
    engagement: number;
    likeCount: number;
    commentCount: number;
    shareCount: number;
  };
}

export interface PaginatedResponse<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
}

export interface ImageUploadResult {
  imageUrn: string;
  uploadUrl: string;
}
