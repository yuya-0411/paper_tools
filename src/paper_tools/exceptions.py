"""アプリケーションで扱う例外．"""


class PaperToolsError(Exception):
    """利用者へ安全に表示できる業務エラー．"""


class NotFoundError(PaperToolsError):
    """対象が存在しない場合のエラー．"""


class ConflictError(PaperToolsError):
    """同時操作などの競合エラー．"""


class ValidationError(PaperToolsError):
    """入力またはテンプレート検証エラー．"""
