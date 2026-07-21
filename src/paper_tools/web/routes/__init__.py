from fastapi import APIRouter

from paper_tools.web.routes.pages import router as pages_router
from paper_tools.web.routes.projects import router as projects_router

router = APIRouter()
router.include_router(pages_router)
router.include_router(projects_router)

__all__ = ["router"]
