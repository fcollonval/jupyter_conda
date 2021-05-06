import { faClone } from '@fortawesome/free-regular-svg-icons/faClone';
import { faSyncAlt } from '@fortawesome/free-solid-svg-icons/faSyncAlt';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { ToolbarButtonComponent } from '@jupyterlab/apputils';
import {
  addIcon,
  buildIcon,
  Button,
  closeIcon,
  downloadIcon,
  fileUploadIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';
import { style } from 'typestyle';
import { CONDA_ENVIRONMENT_TOOLBAR_CLASS } from '../constants';

//Toolbar height to align with package toolbar
export const ENVIRONMENT_TOOLBAR_HEIGHT = 40;

/**
 * Environment panel toolbar properties
 */
export interface ICondaEnvToolBarProps {
  /**
   * Is the current environment the root one
   */
  isBase: boolean;
  /**
   * Is the environment list updating
   */
  isPending: boolean;
  /**
   * Create environment handler
   */
  onCreate(): void;
  /**
   * Clone environment handler
   */
  onClone(): void;
  /**
   * Import environment handler
   */
  onImport(): void;
  /**
   * Export environment handler
   */
  onExport(): void;
  /**
   * Refresh environment handler
   */
  onRefresh(): void;
  /**
   * Remove environment handler
   */
  onRemove(): void;
  /**
   * Solve environment handler
   */
  onSolve(): void;
}

export const CondaEnvToolBar = (props: ICondaEnvToolBarProps): JSX.Element => {
  return (
    <div className={Style.NoGrow}>
      <div className={Style.Title}>
        <span className={Style.Grow}>Conda environments</span>
        <Button
          className="jp-ToolbarButtonComponent"
          onMouseDown={props.onRefresh}
          title="Refresh environments"
          minimal
        >
          <FontAwesomeIcon
            icon={faSyncAlt}
            spin={props.isPending}
            style={{ color: 'var(--jp-inverse-layout-color3)' }}
          />
        </Button>
      </div>
      <div
        className={`lm-Widget jp-Toolbar ${CONDA_ENVIRONMENT_TOOLBAR_CLASS}`}
      >
        <ToolbarButtonComponent
          icon={addIcon}
          tooltip="Create"
          onClick={props.onCreate}
        />
        <ToolbarButtonComponent
          icon={buildIcon}
          tooltip="Solve new"
          onClick={props.onSolve}
        />
        <Button
          className="jp-ToolbarButtonComponent"
          disabled={props.isBase}
          onMouseDown={props.onClone}
          title="Clone"
          minimal
        >
          <FontAwesomeIcon
            icon={faClone}
            style={{ color: 'var(--jp-inverse-layout-color3)' }}
          />
        </Button>
        <ToolbarButtonComponent
          icon={fileUploadIcon}
          tooltip="Import"
          onClick={props.onImport}
        />
        <ToolbarButtonComponent
          icon={downloadIcon}
          tooltip="Export"
          onClick={props.onExport}
        />
        <ToolbarButtonComponent
          icon={closeIcon}
          tooltip="Remove"
          onClick={props.onRemove}
          enabled={!props.isBase}
        />
      </div>
    </div>
  );
};

namespace Style {
  export const Grow = style({
    flexGrow: 1,
    flexShrink: 1
  });

  export const NoGrow = style({
    flexGrow: 0,
    flexShrink: 0
  });

  export const Title = style({
    color: 'var(--jp-ui-font-color1)',
    textAlign: 'center',
    fontWeight: 'bold',
    fontSize: 'var(--jp-ui-font-size2)',
    height: ENVIRONMENT_TOOLBAR_HEIGHT,
    display: 'flex',
    flex: '0 0 auto',
    flexDirection: 'row'
  });
}
