// Lucide icons (ISC/MIT); see licenses/Lucide-LICENSE.
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookMarked,
  Building2,
  Calendar,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
  CircleUserRound,
  CircleX,
  Clipboard,
  Clock,
  CloudUpload,
  CodeXml,
  Columns3,
  Command,
  Compass,
  Component,
  ContactRound,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  GripVertical,
  House,
  Inbox,
  Info,
  KeyRound,
  LayoutGrid,
  Link,
  List,
  ListTodo,
  LogOut,
  Mail,
  Megaphone,
  MessageCircle,
  MessageCirclePlus,
  Mic,
  Moon,
  PanelLeft,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareDot,
  Star,
  Sun,
  Tag,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  UserRoundPlus,
  Users,
  Video,
  X,
  Zap,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

// Keep the compact footprint used throughout Orbit while using upstream icon geometry.
function orbitIcon(Icon: LucideIcon, filled = false) {
  return function OrbitIcon({ size = 20, strokeWidth = 2, ...props }: LucideProps) {
    return (
      <Icon
        size={size}
        viewBox="-4 -4 32 32"
        strokeWidth={strokeWidth}
        fill={filled ? "currentColor" : "none"}
        {...props}
      />
    );
  };
}

export const AccessIcon = orbitIcon(KeyRound);
export const ActivityIcon = orbitIcon(Activity);
export const AlertIcon = orbitIcon(CircleAlert);
export const AnnouncementIcon = orbitIcon(Megaphone);
export const AppsIcon = orbitIcon(LayoutGrid);
export const ArchiveIcon = orbitIcon(Archive);
export const ArrowDownIcon = orbitIcon(ArrowDown);
export const ArrowLeftIcon = orbitIcon(ArrowLeft);
export const ArrowRightIcon = orbitIcon(ArrowRight);
export const ArrowUpIcon = orbitIcon(ArrowUp);
export const ArrowUpRightIcon = orbitIcon(ArrowUpRight);
export const BoltIcon = orbitIcon(Zap);
export const BookWithBookmarkIcon = orbitIcon(BookMarked);
export const BuildingsIcon = orbitIcon(Building2);
export const CalendarIcon = orbitIcon(Calendar);
export const ChartIcon = orbitIcon(ChartNoAxesColumnIncreasing);
export const ChatBubbleIcon = orbitIcon(MessageCircle);
export const ChatBubblePlusIcon = orbitIcon(MessageCirclePlus);
export const CheckCircleIcon = orbitIcon(CircleCheck);
export const CheckIcon = orbitIcon(Check);
export const ChecklistIcon = orbitIcon(ListTodo);
export const ChevronDownIcon = orbitIcon(ChevronDown);
export const ChevronLeftIcon = orbitIcon(ChevronLeft);
export const ChevronRightIcon = orbitIcon(ChevronRight);
export const ClipboardIcon = orbitIcon(Clipboard);
export const ClockIcon = orbitIcon(Clock);
export const CloseIcon = orbitIcon(X);
export const CodeBlockIcon = orbitIcon(CodeXml);
export const CommandIcon = orbitIcon(Command);
export const CompassIcon = orbitIcon(Compass);
export const ComponentIcon = orbitIcon(Component);
export const CopyIcon = orbitIcon(Copy);
export const CreditCardIcon = orbitIcon(CreditCard);
export const ExternalLinkIcon = orbitIcon(ExternalLink);
export const EyeHideIcon = orbitIcon(EyeOff);
export const EyeIcon = orbitIcon(Eye);
export const FileCodeIcon = orbitIcon(FileCode2);
export const FileCsvIcon = orbitIcon(FileSpreadsheet);
export const FileIcon = orbitIcon(File);
export const FileMarkdownIcon = orbitIcon(FileText);
export const GearIcon = orbitIcon(Settings);
export const GridIcon = orbitIcon(Columns3);
export const HomeIcon = orbitIcon(House);
export const InboxIcon = orbitIcon(Inbox);
export const InformationIcon = orbitIcon(Info);
export const LinearBacklogIcon = orbitIcon(CircleDashed);
export const LinearCanceledIcon = orbitIcon(CircleX);
export const LinearDoneIcon = orbitIcon(CircleCheck);
export const LinearInProgressIcon = orbitIcon(CircleDot);
export const LinearInReviewIcon = orbitIcon(CircleEllipsis);
export const LinearTodoIcon = orbitIcon(Circle);
export const LinkIcon = orbitIcon(Link);
export const ListIcon = orbitIcon(List);
export const LogOutIcon = orbitIcon(LogOut);
export const MailIcon = orbitIcon(Mail);
export const MicrophoneIcon = orbitIcon(Mic);
export const MoonIcon = orbitIcon(Moon);
export const PaperAirplaneIcon = orbitIcon(Send);
export const PaperclipIcon = orbitIcon(Paperclip);
export const PencilIcon = orbitIcon(Pencil);
export const PlayIcon = orbitIcon(Play);
export const PlusIcon = orbitIcon(Plus);
export const ProjectIcon = orbitIcon(Folder);
export const RecordIcon = orbitIcon(CircleDot);
export const RefreshIcon = orbitIcon(RefreshCw);
export const ReorderHandlesIcon = orbitIcon(GripVertical);
export const ReplyIcon = orbitIcon(Reply);
export const SearchIcon = orbitIcon(Search);
export const ShieldLockIcon = orbitIcon(Shield);
export const ShieldTickIcon = orbitIcon(ShieldCheck);
export const SidebarIcon = orbitIcon(PanelLeft);
export const SlidersIcon = orbitIcon(SlidersHorizontal);
export const SparklesIcon = orbitIcon(Sparkles);
export const StarFilledIcon = orbitIcon(Star, true);
export const StarOutlineIcon = orbitIcon(Star);
export const StaticTrashIcon = orbitIcon(Trash2);
export const SunIcon = orbitIcon(Sun);
export const TagIcon = orbitIcon(Tag);
export const ThumbsUpIcon = orbitIcon(ThumbsUp);
export const UnreadSquareBadgeIcon = orbitIcon(SquareDot);
export const UploadCloudIcon = orbitIcon(CloudUpload);
export const UserCircleIcon = orbitIcon(CircleUserRound);
export const UserCirclePlusIcon = orbitIcon(UserRoundPlus);
export const UserLinkIcon = orbitIcon(ContactRound);
export const UsersIcon = orbitIcon(Users);
export const VideoCameraIcon = orbitIcon(Video);
export const WarningTriangleIcon = orbitIcon(TriangleAlert);
